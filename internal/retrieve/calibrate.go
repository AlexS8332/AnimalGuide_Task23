package retrieve

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/AlexS8332/AnimalGuide_Task23/internal/kb"
)

// CalibStep — шаг перебора абсолютного порога.
const CalibStep = 0.005

// Calibrate подбирает порог и (если write) пишет его в индекс
// (kb.Store.SetMinScore).
//
// Конфигурация — `filter` (без переписывания и реранкинга) с заданным
// Delta и K1 = DefaultK1: порог подбирается для того фильтра, который его
// применяет. Поиск — один раз на вопрос; перебор порога — пересчёт фильтра
// по той же выдаче. Диапазон — от наименьшего лучшего косинуса минус 0.03
// до наибольшего плюс шаг: ниже порог ничего не режет, выше — режет всё.
// Порог по BM25 не калибруется: при откате поиска — ошибка.
func Calibrate(ctx context.Context, p *Pipeline, qs kb.QuestionSet, index string, delta, maxDrop float64, write bool) (Calibration, error) {
	if p == nil || p.Searcher == nil || p.Searcher.Store == nil {
		return Calibration{}, errors.New("конвейеру не передана база знаний")
	}
	cfg := resolve(Config{Index: index, Filter: true, Delta: delta})
	if maxDrop < 0 {
		maxDrop = 0
	}
	cal := Calibration{Index: cfg.Index, Delta: cfg.Delta, MaxDrop: maxDrop, Created: time.Now().UTC()}
	cal.Embedder = "нет"
	if p.Searcher.Embedder != nil {
		cal.Embedder = p.Searcher.Embedder.Model()
	}
	ev := &evidenceSet{st: p.Searcher.Store, texts: map[string]string{}}
	type item struct {
		id  string
		dev bool
		ev  []evidence
		t   Trace
	}
	var items []item
	for _, sp := range []string{kb.SplitDev, kb.SplitOut} {
		for _, q := range qs.Split(sp) {
			it := item{id: q.ID}
			switch {
			case sp == kb.SplitDev && q.Answerable:
				if it.ev = ev.of(ctx, q); len(it.ev) == 0 {
					continue
				}
				it.dev = true
			case sp == kb.SplitOut || !q.Answerable:
			default:
				continue
			}
			t, err := p.gather(ctx, Query{Text: q.Q, Context: q.Context}, cfg)
			if err != nil {
				return cal, fmt.Errorf("%s: %w", q.ID, err)
			}
			if t.Info.Mode != kb.Dense {
				return cal, fmt.Errorf("порог — косинус dense, а поиск откатился на BM25 (%s): калибровать нечего — поднимите эмбеддер",
					orText(t.Info.Fallback, "нет векторов"))
			}
			it.t = t
			items = append(items, it)
			if len(t.Anchored) > 0 {
				cal.Anchored = append(cal.Anchored, q.ID)
			}
			if it.dev {
				cal.DevN++
				cal.DevTop = append(cal.DevTop, round3(t.TopDense))
			} else {
				cal.OutN++
				cal.OutTop = append(cal.OutTop, round3(t.TopDense))
			}
		}
	}
	if cal.DevN == 0 {
		return cal, errors.New("в dev нет отвечаемых вопросов с доказательствами — калибровать не на чем")
	}
	// apply — фильтр с порогом (th < 0 — без фильтра): у каких dev
	// доказательство в итоге, сколько out пусты.
	apply := func(th float64) (hit map[string]bool, empty int) {
		hit = map[string]bool{}
		for _, it := range items {
			t := it.t
			t.Candidates = append([]Candidate(nil), it.t.Candidates...)
			if th < 0 {
				t.Config.Filter = false
			} else {
				t.MinScore = th
			}
			finish(&t)
			if it.dev {
				for _, h := range t.Hits {
					if relevant(h.Chunk, it.ev) {
						hit[it.id] = true
						break
					}
				}
			} else if t.Empty {
				empty++
			}
		}
		return hit, empty
	}
	baseHit, _ := apply(-1)
	cal.Base = ratio(len(baseHit), cal.DevN)

	tops := append(append([]float64(nil), cal.DevTop...), cal.OutTop...)
	sort.Float64s(tops)
	lo := math.Floor((tops[0]-0.03)/CalibStep) * CalibStep
	hi := math.Ceil((tops[len(tops)-1]+CalibStep)/CalibStep) * CalibStep
	cal.Chosen = -1
	for th := lo; th <= hi+1e-9; th += CalibStep {
		th = round3(th)
		hit, empty := apply(th)
		row := CalibRow{MinScore: th, DevRecall: ratio(len(hit), cal.DevN), OutEmpty: ratio(empty, cal.OutN)}
		for id := range baseHit {
			if !hit[id] {
				row.LostDev = append(row.LostDev, id)
			}
		}
		sort.Strings(row.LostDev)
		cal.Table = append(cal.Table, row)
		if row.DevRecall >= cal.Base-maxDrop-1e-9 {
			cal.Chosen = th
		}
	}
	if cal.Chosen < 0 {
		// Даже самый низкий порог теряет больше MaxDrop: теряет
		// относительный порог, а не абсолютный.
		cal.Chosen = round3(lo)
		cal.Note = fmt.Sprintf("recall падает больше чем на %.2f уже при самом низком пороге: теряет относительный порог (Delta %.2f) — его и надо менять", maxDrop, cal.Delta)
	}
	if write {
		if err := p.Searcher.Store.SetMinScore(ctx, cal.Index, cal.Chosen); err != nil {
			return cal, fmt.Errorf("порог не записан: %w", err)
		}
		cal.Written = true
	}
	return cal, nil
}

func round3(x float64) float64 { return math.Round(x*1000) / 1000 }

// Row — строка таблицы с выбранным порогом.
func (c Calibration) chosenRow() (CalibRow, bool) {
	for _, r := range c.Table {
		if math.Abs(r.MinScore-c.Chosen) < 1e-9 {
			return r, true
		}
	}
	return CalibRow{}, false
}

// Markdown — для examples/rag/calibrate.md (добавление к контракту): выбор,
// гистограммы лучших косинусов dev и out, таблица «порог → recall dev,
// пусто на out, потерянные dev».
func (c Calibration) Markdown() string {
	var b strings.Builder
	b.WriteString("# Калибровка порога релевантности\n\n")
	fmt.Fprintf(&b, "Индекс `%s`, эмбеддер %s. %s. Вопросы: dev (отвечаемые с доказательством) — %d, out — %d. Test не используется: на нём порог проверяется, а не подбирается.\n\n",
		c.Index, c.Embedder, c.Created.Format("2006-01-02 15:04"), c.DevN, c.OutN)
	fmt.Fprintf(&b, "Фильтр — как у конфигурации `filter`: абсолютный пол косинуса, относительный порог «не хуже лучшего на %.2f», отсев повторов текста, K1 = %d. "+
		"Перебор с шагом %.3f; выбирается наибольший порог, при котором доказательство в итоге на dev теряется не больше чем на %.2f против выдачи без фильтра (%.2f).\n\n",
		c.Delta, DefaultK1, CalibStep, c.MaxDrop, c.Base)
	b.WriteString("## Выбор\n\n")
	if r, ok := c.chosenRow(); ok {
		fmt.Fprintf(&b, "Порог **%.3f**: recall на dev %.2f (без фильтра %.2f), пусто на out %d из %d.", c.Chosen, r.DevRecall, c.Base,
			int(math.Round(r.OutEmpty*float64(c.OutN))), c.OutN)
	} else {
		fmt.Fprintf(&b, "Порог **%.3f**.", c.Chosen)
	}
	if c.Written {
		b.WriteString(" Записан в индекс.\n")
	} else {
		b.WriteString(" В индекс не записан (`kb calibrate -write` запишет).\n")
	}
	if c.Note != "" {
		b.WriteString("\n" + c.Note + "\n")
	}
	b.WriteString("\n## Лучший косинус кандидатов\n\n")
	fmt.Fprintf(&b, "- dev: %s\n- out: %s\n", floats(c.DevTop), floats(c.OutTop))
	if len(c.Anchored) > 0 {
		fmt.Fprintf(&b, "\nВ запросе назван вид корпуса (якорь: пол к ним не применяется, и порог их не касается): %s.\n", strings.Join(c.Anchored, ", "))
	}
	b.WriteString("\n" + histogram(c.DevTop, c.OutTop))
	b.WriteString("\n## Таблица\n\n| порог | recall dev | пусто на out | потеряно на dev |\n|---|---|---|---|\n")
	for _, r := range c.Table {
		mark := ""
		if math.Abs(r.MinScore-c.Chosen) < 1e-9 {
			mark = " ◀"
		}
		fmt.Fprintf(&b, "| %.3f%s | %.2f | %d из %d | %s |\n", r.MinScore, mark, r.DevRecall,
			int(math.Round(r.OutEmpty*float64(c.OutN))), c.OutN, orText(strings.Join(r.LostDev, ", "), "—"))
	}
	return b.String()
}

func floats(xs []float64) string {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	parts := make([]string, len(s))
	for i, x := range s {
		parts[i] = fmt.Sprintf("%.3f", x)
	}
	return orText(strings.Join(parts, " "), "—")
}

// histogram — столбики по корзинам 0.01: «0.83 | dev ███ | out █».
func histogram(dev, out []float64) string {
	all := append(append([]float64(nil), dev...), out...)
	if len(all) == 0 {
		return ""
	}
	sort.Float64s(all)
	lo := math.Floor(all[0]*100) / 100
	hi := math.Floor(all[len(all)-1]*100) / 100
	var b strings.Builder
	b.WriteString("```\n")
	for x := lo; x <= hi+1e-9; x += 0.01 {
		d, o := 0, 0
		for _, v := range dev {
			if v >= x-1e-9 && v < x+0.01-1e-9 {
				d++
			}
		}
		for _, v := range out {
			if v >= x-1e-9 && v < x+0.01-1e-9 {
				o++
			}
		}
		fmt.Fprintf(&b, "%.2f  dev %-12s out %s\n", x, strings.Repeat("█", d), strings.Repeat("█", o))
	}
	b.WriteString("```\n")
	return b.String()
}
