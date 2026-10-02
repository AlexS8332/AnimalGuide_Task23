package bench

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/AlexS8332/AnimalGuide_Task23/internal/embed"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/features"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/kb"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/rag"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/retrieve"
)

// Дорожки И-11: часть A — поиск без модели (конвейер retrieve), часть B —
// отвечающий агент в режимах rag и rag+both.
const (
	laneRetrieve = "поиск"
	laneAnsBoth  = "rag+both"
)

// Пороги И-11 (задание 23).
const (
	rerankK1        = 5
	rerankOutEmpty  = 0.75 // доля вопросов вне базы, где фильтр оставил пусто
	rerankMaxDrop   = 0.05 // падение recall filter против base на dev+test
	rerankCalibDrop = 0.05 // MaxDrop калибровки
)

// Rerank — И-11: «Фильтр и переписывание запроса».
//
// Часть A — без модели, как И-9: порог абсолютного пола калибруется на
// dev+out (retrieve.Calibrate; в индекс не пишется — он в заметке), затем
// матрица base / filter / rewrite / both при K1 = 5 на dev, test и out с
// этим порогом (retrieve.RunMatrix). Жёсткие проверки:
//
//  1. на вопросах вне базы (тип out-of-base: out и test) у filter после
//     фильтра пусто не меньше чем в 75 % вопросов. Вопросы «аспекта нет»
//     (aspect-missing: вид в базе есть, нужного факта нет) в проверку не
//     входят: о виде в базе есть статья, и фильтр релевантности обязан её
//     оставить — «не знаю» там дело ответа (v24); их пустых — отчётное
//     число;
//  2. recall@5 после фильтра на dev+test падает против base не больше чем на
//     0.05 — в вопросах не больше чем на 1 из 27;
//  3. rewrite поднимает «доказательство в топ-5» на вопросах synonym и
//     followup (dev+test) хотя бы на один вопрос и ни на одном не ухудшает;
//  4. both не хуже base по recall@5 на dev+test.
//
// Часть B — как часть A И-10: отвечающий агент на test в режимах rag и
// rag+both (один повтор, судья) — только отчётные числа: верно, уверенные
// ошибки, «не знаю» на неотвечаемых, токены фрагментов, цена. Без модели
// (Env.LLM == nil) часть B пропускается с заметкой.
//
// Нет kb.db или эмбеддера — проверки «не определено» с причиной: порог —
// косинус dense, по BM25 его не проверить.
type Rerank struct {
	// KBPath — kb.db; пусто — Env.KB, иначе kb.db в корне репозитория.
	KBPath string
	// Questions — пусто → DefaultQuestions.
	Questions string
	// Embedder — nil → embed.FromEnv, если сайдкар отвечает.
	Embedder embed.Embedder
	// NoAnswers — без части B (только поиск).
	NoAnswers bool
}

// NewRerank — И-11 с настройками по умолчанию.
func NewRerank() *Rerank { return &Rerank{} }

func (t *Rerank) ID() string    { return "И-11" }
func (t *Rerank) Title() string { return "Фильтр и переписывание запроса" }

// rerankChecks — жёсткие проверки части A.
var rerankChecks = []string{
	"filter: пусто на вопросах вне базы (out-of-base, K1 = 5)",
	"filter: recall@5 на dev+test не ниже base больше чем на 0.05",
	"rewrite: доказательство в топ-5 на synonym и followup (dev+test)",
	"both: recall@5 на dev+test не ниже base",
}

func (t *Rerank) Run(ctx context.Context, s *Stand, r *Result) error {
	r.Goal = "второй этап поиска: фильтр отсекает выдачу на вопросах вне базы и не теряет доказательств, переписывание находит синонимы и продолжения"
	r.Mechanism = features.RAGFilter
	r.Lanes = append(r.Lanes,
		LaneInfo{Name: laneRetrieve, Note: "конвейер retrieve без модели: base, filter, rewrite, both при K1 = 5; порог — калибровка на dev+out",
			Diff: "не диалог: поиск без модели"},
		LaneInfo{Name: laneAnsRAG, Note: "отвечающий агент: прямой поиск, k = 5", Diff: "часть B: один запрос к модели"},
		LaneInfo{Name: laneAnsBoth, Note: "тот же агент и промпт: выдача через конвейер (rewrite code, rerank hybrid, filter)",
			Diff: "+ rag.rewrite, rag.filter"})

	qs, err := kb.LoadQuestions(orDefault(t.Questions, DefaultQuestions))
	if err != nil {
		r.yes("контрольные вопросы читаются", laneRetrieve, false, err.Error())
		return nil
	}
	path := t.kbPath(s)
	pending := func(why string) {
		for _, c := range rerankChecks {
			r.pending(c, "—", laneRetrieve, why)
		}
	}
	if _, err := os.Stat(path); err != nil {
		pending(fmt.Sprintf("базы знаний нет: %s — соберите: go run ./cmd/kb index -strategy all", path))
		return nil
	}
	emb := t.Embedder
	if emb == nil {
		h := embed.FromEnv()
		hs := h.Health(ctx)
		if !hs.OK {
			pending("эмбеддер недоступен (" + hs.Why + "): порог фильтра — косинус dense, по BM25 его не проверить; поднимите сайдкар: uv run embedder/server.py")
			return nil
		}
		emb = h
	}
	st, err := kb.Open(ctx, path)
	if err != nil {
		return fmt.Errorf("И-11: база знаний %s: %w", path, err)
	}
	defer st.Close()
	p := &retrieve.Pipeline{Searcher: &kb.Searcher{Store: st, Embedder: emb}}

	// Часть A.
	s.env.logf("  И-11: калибровка порога на dev+out")
	cal, err := retrieve.Calibrate(ctx, p, qs, "", 0, rerankCalibDrop, false)
	if err != nil {
		pending("калибровка не состоялась: " + err.Error())
		return nil
	}
	r.note("Калибровка на dev+out (в индекс не записана): порог %.3f — recall на dev %.2f при %.2f без фильтра; лучший косинус вопросов вне базы до %.3f; якорные (назван вид корпуса, пол к ним не применяется): %s.",
		cal.Chosen, rowAt(cal, cal.Chosen).DevRecall, cal.Base, maxOf(cal.OutTop), orDash(strings.Join(cal.Anchored, ", ")))
	configs := retrieve.Presets(false)
	for i := range configs {
		if configs[i].Config.Filter {
			configs[i].Config.MinScore = cal.Chosen
		}
	}
	s.env.logf("  И-11: матрица base/filter/rewrite/both, K1 = %d, dev/test/out", rerankK1)
	m, err := retrieve.RunMatrix(ctx, p, qs, configs, []int{rerankK1}, []string{kb.SplitDev, kb.SplitTest, kb.SplitOut})
	if err != nil {
		return fmt.Errorf("И-11: матрица: %w", err)
	}
	if m.Fallback != "" {
		pending("поиск откатился на BM25 (" + m.Fallback + "): порог по косинусу не проверить")
		return nil
	}
	t.judge(r, m)
	t.report(r, m)
	if dir := s.Dir(); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "filter.md"), []byte(m.Markdown()), 0o644)
			_ = os.WriteFile(filepath.Join(dir, "calibrate.md"), []byte(cal.Markdown()), 0o644)
		}
	}

	// Часть B.
	if t.NoAnswers {
		return nil
	}
	if s.env.LLM == nil {
		r.note("Часть B (ответы rag и rag+both) пропущена: стенду не передан клиент модели.")
		return nil
	}
	a := &rag.Answerer{LLM: s.env.LLM, Model: s.env.Model, Searcher: p.Searcher, Pipeline: p,
		Configs: map[rag.Mode]retrieve.Config{rag.RAGBoth: {MinScore: cal.Chosen}}}
	s.env.logf("  И-11: test, rag и rag+both, судья")
	rep, err := rag.Eval(ctx, a, qs, rag.EvalOptions{Splits: []string{kb.SplitTest}, Modes: []rag.Mode{rag.RAG, rag.RAGBoth},
		Repeats: 1, Judge: &rag.Judge{LLM: s.env.LLM, Model: s.env.Model}, Seed: ragSeed,
		Progress: func(row rag.Row) {
			s.env.logf("  И-11 %s: rag %s, rag+both %s", row.Question.ID, orDash(string(row.Majority[rag.RAG])), orDash(string(row.Majority[rag.RAGBoth])))
		}})
	if err != nil {
		return fmt.Errorf("И-11: ответы: %w", err)
	}
	t.answers(r, rep)
	return nil
}

func (t *Rerank) kbPath(s *Stand) string {
	if t.KBPath != "" {
		return t.KBPath
	}
	if s.env.KB != "" {
		return s.env.KB
	}
	return DefaultCacheDB
}

// rowAt — строка калибровки с порогом.
func rowAt(c retrieve.Calibration, th float64) retrieve.CalibRow {
	for _, r := range c.Table {
		if r.MinScore > th-1e-9 && r.MinScore < th+1e-9 {
			return r
		}
	}
	return retrieve.CalibRow{}
}

func maxOf(xs []float64) float64 {
	m := 0.0
	for _, x := range xs {
		m = max(m, x)
	}
	return m
}

// mq — вопросы конфигурации при K1 = 5 на наборах.
func mq(m retrieve.Matrix, name string, splits ...string) []retrieve.MatrixQ {
	var out []retrieve.MatrixQ
	for _, r := range m.Rows {
		if r.Name != name || r.K1 != rerankK1 {
			continue
		}
		for _, sp := range splits {
			if r.Split == sp {
				out = append(out, r.Rows...)
			}
		}
	}
	return out
}

// top5 — у каких вопросов доказательство в итоговом топ-5.
func top5(rows []retrieve.MatrixQ) map[string]bool {
	out := map[string]bool{}
	for _, q := range rows {
		if q.Answerable && q.RankAfter > 0 && q.RankAfter <= rerankK1 {
			out[q.ID] = true
		}
	}
	return out
}

func answerableN(rows []retrieve.MatrixQ) int {
	n := 0
	for _, q := range rows {
		if q.Answerable {
			n++
		}
	}
	return n
}

// diff — id из a, которых нет в b, по порядку.
func diff(a, b map[string]bool) []string {
	var out []string
	for id := range a {
		if !b[id] {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// judge — жёсткие проверки части A.
func (t *Rerank) judge(r *Result, m retrieve.Matrix) {
	all := []string{kb.SplitDev, kb.SplitTest, kb.SplitOut}
	dt := []string{kb.SplitDev, kb.SplitTest}

	// 1. Пусто на вопросах вне базы.
	var outIDs, emptyIDs []string
	aspect, aspectEmpty := 0, 0
	for _, q := range mq(m, "filter", all...) {
		switch q.Type {
		case "out-of-base":
			outIDs = append(outIDs, q.ID)
			if q.Empty {
				emptyIDs = append(emptyIDs, q.ID)
			}
		case "aspect-missing":
			aspect++
			if q.Empty {
				aspectEmpty++
			}
		}
	}
	c := Check{What: rerankChecks[0], Want: fmt.Sprintf("≥ %.0f %%", 100*rerankOutEmpty), Lane: laneRetrieve}
	if len(outIDs) == 0 {
		c.Status, c.Got, c.Note = Pending, "—", "в наборах нет вопросов out-of-base"
	} else {
		share := float64(len(emptyIDs)) / float64(len(outIDs))
		c.Got = fmt.Sprintf("%d из %d (%.0f %%)", len(emptyIDs), len(outIDs), 100*share)
		c.Status = Pass
		if share+1e-9 < rerankOutEmpty {
			c.Status = Fail
		}
		var left []string
		for _, id := range outIDs {
			if !contains(emptyIDs, id) {
				left = append(left, id)
			}
		}
		if len(left) > 0 {
			c.Note = "не пусто: " + strings.Join(left, ", ")
		}
	}
	r.check(c)
	r.metric("filter: пусто на вопросах «аспекта нет» (вид в базе есть; отчётно)", laneRetrieve, "%d из %d", aspectEmpty, aspect)

	// 2. Recall filter против base.
	base, filter := top5(mq(m, "base", dt...)), top5(mq(m, "filter", dt...))
	n := answerableN(mq(m, "base", dt...))
	allowed := int(rerankMaxDrop*float64(n) + 1e-9)
	drop := len(base) - len(filter)
	c = Check{What: rerankChecks[1], Want: fmt.Sprintf("падение ≤ %.2f (≤ %d из %d)", rerankMaxDrop, allowed, n), Lane: laneRetrieve,
		Got: fmt.Sprintf("base %d, filter %d из %d (%+d)", len(base), len(filter), n, len(filter)-len(base)), Status: Pass}
	if n == 0 {
		c.Status, c.Note = Pending, "нет отвечаемых вопросов"
	} else if drop > allowed {
		c.Status = Fail
	}
	if lost := diff(base, filter); len(lost) > 0 {
		c.Note = joinText(c.Note, "потеряны: "+strings.Join(lost, ", "))
	}
	r.check(c)

	// 3. Rewrite на synonym и followup.
	pick := func(rows []retrieve.MatrixQ) []retrieve.MatrixQ {
		var out []retrieve.MatrixQ
		for _, q := range rows {
			if q.Type == "synonym" || q.Type == "followup" {
				out = append(out, q)
			}
		}
		return out
	}
	bs, rw := top5(pick(mq(m, "base", dt...))), top5(pick(mq(m, "rewrite", dt...)))
	sn := answerableN(pick(mq(m, "base", dt...)))
	gain, loss := diff(rw, bs), diff(bs, rw)
	c = Check{What: rerankChecks[2], Want: "≥ +1 вопрос и ни одного хуже", Lane: laneRetrieve,
		Got: fmt.Sprintf("base %d, rewrite %d из %d", len(bs), len(rw), sn), Status: Pass}
	if len(gain) < 1 || len(loss) > 0 {
		c.Status = Fail
	}
	var notes []string
	if len(gain) > 0 {
		notes = append(notes, "поднял: "+strings.Join(gain, ", "))
	}
	if len(loss) > 0 {
		notes = append(notes, "ухудшил: "+strings.Join(loss, ", "))
	}
	c.Note = strings.Join(notes, "; ")
	if sn == 0 {
		c.Status, c.Note = Pending, "нет вопросов synonym и followup"
	}
	r.check(c)

	// 4. Both не хуже base.
	both := top5(mq(m, "both", dt...))
	c = Check{What: rerankChecks[3], Want: "≥ base", Lane: laneRetrieve,
		Got: fmt.Sprintf("base %d, both %d из %d", len(base), len(both), n), Status: Pass}
	if len(both) < len(base) {
		c.Status = Fail
	}
	var bn []string
	if g := diff(both, base); len(g) > 0 {
		bn = append(bn, "поднял: "+strings.Join(g, ", "))
	}
	if l := diff(base, both); len(l) > 0 {
		bn = append(bn, "потерял: "+strings.Join(l, ", "))
	}
	c.Note = strings.Join(bn, "; ")
	r.check(c)
}

// report — отчётные числа части A.
func (t *Rerank) report(r *Result, m retrieve.Matrix) {
	r.metric("индекс, эмбеддер, порог", laneRetrieve, "%s, %s, пол %.3f, «не хуже лучшего на %.2f»; corpus_sha %s",
		m.Index, m.Embedder, m.MinScore, m.Delta, clip(m.CorpusSHA, 12))
	for _, row := range m.Rows {
		lane := laneRetrieve
		what := fmt.Sprintf("%s, %s", row.Name, row.Split)
		if row.N > 0 {
			r.metric(what+": recall до / после, MRR, precision", lane, "%.2f / %.2f, %.2f, %.2f (N = %d)", row.RecallBefore, row.RecallAfter, row.MRR, row.Precision, row.N)
		}
		if row.OutN > 0 {
			r.metric(what+": пусто на неотвечаемых", lane, "%d из %d", int(row.OutEmpty*float64(row.OutN)+0.5), row.OutN)
		}
		r.metric(what+": отсечено, токенов на вопрос", lane, "%.0f %%, %.0f", 100*row.CutShare, row.Tokens)
	}
	for _, c := range m.Conclusion {
		r.note("%s", c)
	}
}

// answers — отчётные числа части B.
func (t *Rerank) answers(r *Result, rep rag.Report) {
	un := 0
	for _, row := range rep.Rows {
		if !row.Question.Answerable {
			un++
		}
	}
	for _, st := range rep.Stats {
		lane := string(st.Mode)
		tokens, n := 0, 0
		for _, row := range rep.Rows {
			for _, run := range row.Runs[st.Mode] {
				if run.Error != "" {
					continue
				}
				n++
				for _, h := range run.Answer.Hits {
					tokens += h.Tokens
				}
			}
		}
		r.metric("верно / частично / неверно / «не знаю»", lane, "%d / %d / %d / %d из %d", st.Correct, st.Partial, st.Wrong, st.Abstain, st.Questions)
		r.metric("уверенных ошибок на отвечаемых", lane, "%d", st.ConfidentWrong)
		r.metric("«не знаю» на вопросах без ответа в базе", lane, "%d из %d", st.RightAbstain, un)
		if n > 0 {
			r.metric("токенов фрагментов на ответ", lane, "%d", tokens/n)
		}
		r.metric("доказательство в выдаче (test)", lane, "%.2f", st.Recall)
		r.metric("токены запросов (из кэша)", lane, "%d → %d (%d)", st.Usage.Prompt, st.Usage.Completion, st.Usage.CacheHit)
		r.metric("цена ответов", lane, "$%.4f", st.Cost.USD)
	}
	r.metric("цена судьи", "судья", "$%.4f", rep.JudgeCost.USD)
	for _, c := range rep.Conclusion {
		r.note("Часть B: %s", c)
	}
}

func joinText(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	}
	return a + "; " + b
}
