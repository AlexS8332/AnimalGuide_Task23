package retrieve

import (
	"context"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/AlexS8332/AnimalGuide_Task23/internal/corpus"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/kb"
)

// Словарь названий и его правила.
//
// Совпадение — по основам слов, а не по строке: «кошачьего медведя» должен
// найтись как «кошачий медведь». Основа своя, а не words.Stems: тот отрезает
// две последние буквы у любого слова длиннее четырёх, и «барсук» у него
// становится «барс» — синоним ирбиса нашёлся бы в вопросе про барсука.
// Здесь отрезается окончание из короткого списка (падежные окончания
// существительных и прилагательных, притяжательное «-ов/-ова»), основа не
// короче трёх букв; «барс» и «барсук» остаются разными словами.
//
// Многословное название ищется как подряд идущие слова. Правила разбора:
//
//  1. Длинное совпадение раньше короткого: слова, вошедшие в найденное
//     название, второй раз не используются. «Кошачий медведь» — малая
//     панда, и «медведь» внутри него не раскрывается в бурого.
//  2. Однословный синоним, который входит словом в название ДРУГОГО вида,
//     не раскрывается никогда: он общий. «Медведь» (синоним бурого) есть в
//     «белом», «гималайском» и «кошачьем медведе», «барс» — в «амурском
//     барсе», «рысь» — в «степной рыси» (каракал). Сказать «медведь» — не
//     назвать вид.
//  3. Однословный синоним после слова-определения («пятнистая гиена»,
//     «морская выдра», «чёрный медведь») не раскрывается: определение
//     называет, скорее всего, другой вид, которого в корпусе нет. Признак
//     определения — окончание прилагательного; местоимения «какой», «этот»
//     и подобные определением не считаются.
//  4. Каноническое название вида в запросе не раскрывается (раскрывать
//     нечего), но вид считается названным: для вопроса-продолжения и для
//     латыни.
//  5. Однословное название с основой короче четырёх букв ищется только
//     точной формой: у «долов» (синоним красного волка) основа «дол», и
//     по основе он нашёлся бы в «долю рациона».
//
// Пропущенное раскрытие безопасно — запрос уходит как есть; ошибочное —
// добавляет в запрос чужой вид и уводит поиск. Поэтому правила 2 и 3
// осторожны: лучше не раскрыть «гиену», чем раскрыть «пятнистую гиену» в
// полосатую.

// endings — окончания, которые отрезаются от слова (по убыванию длины).
var endings = func() []string {
	list := []string{
		"овой", "евой", "овым", "евым",
		"ого", "его", "ому", "ему", "ыми", "ими", "ами", "ями", "ова", "ева", "ову", "еву", "овы", "евы", "ове", "еве",
		"ой", "ей", "ий", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ую", "юю", "ом", "ем", "ам", "ям",
		"ах", "ях", "ов", "ев", "ым", "им",
		"а", "я", "ы", "и", "у", "ю", "е", "о", "ь", "й",
	}
	sort.SliceStable(list, func(i, j int) bool { return utf8.RuneCountInString(list[i]) > utf8.RuneCountInString(list[j]) })
	return list
}()

// adjEndings — окончания прилагательного (правило 3).
var adjEndings = []string{"ый", "ий", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ого", "его", "ому", "ему", "ым", "им", "ых", "их", "ую", "юю", "ыми", "ими"}

// determiners — местоимения с окончанием прилагательного: перед названием
// вида они его не меняют («какая гиена», «этот медведь»).
var determiners = map[string]bool{
	"какой": true, "какая": true, "какое": true, "какие": true, "каких": true, "каким": true, "какую": true, "какого": true,
	"такой": true, "такая": true, "такое": true, "такие": true, "этот": true, "эта": true, "это": true, "эти": true,
	"этого": true, "этой": true, "тот": true, "та": true, "те": true, "каждый": true, "каждая": true, "любой": true,
	"любая": true, "мой": true, "моя": true, "наш": true, "наша": true, "весь": true, "вся": true, "все": true, "сам": true,
	"самый": true, "самая": true, "другой": true, "другая": true, "ваш": true, "ваша": true, "твой": true, "твоя": true,
}

// stem — основа слова: нижний регистр, «ё» как «е», без окончания из
// endings (основа не короче трёх букв) и без мягкого знака на конце основы
// («кошачьего» → «кошачь» → «кошач», как «кошачий»).
func stem(w string) string {
	w = strings.ReplaceAll(strings.ToLower(w), "ё", "е")
	n := utf8.RuneCountInString(w)
	for _, e := range endings {
		if strings.HasSuffix(w, e) && n-utf8.RuneCountInString(e) >= 3 {
			w = strings.TrimSuffix(w, e)
			break
		}
	}
	if strings.HasSuffix(w, "ь") && utf8.RuneCountInString(w) > 3 {
		w = strings.TrimSuffix(w, "ь")
	}
	return w
}

// sameStem — основы совпадают; длинные основы — и с разницей в одну
// букву на конце («солонг» / «солонго» — беглая гласная и «-ой/-оя»).
// Короче пяти букв — только точно: «барс» не «барсук».
func sameStem(a, b string) bool {
	if a == b {
		return true
	}
	la, lb := utf8.RuneCountInString(a), utf8.RuneCountInString(b)
	if la > lb {
		a, b, la, lb = b, a, lb, la
	}
	return la >= 5 && lb-la == 1 && strings.HasPrefix(b, a)
}

// token — слово текста.
type token struct {
	word string // нижний регистр, ё → е
	stem string
	from int // байтовые смещения в тексте
	to   int
}

func tokenize(s string) []token {
	var out []token
	start := -1
	flush := func(end int) {
		if start >= 0 {
			w := strings.ReplaceAll(strings.ToLower(s[start:end]), "ё", "е")
			out = append(out, token{word: w, stem: stem(w), from: start, to: end})
			start = -1
		}
	}
	for i, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if start < 0 {
				start = i
			}
			continue
		}
		flush(i)
	}
	flush(len(s))
	return out
}

// entry — название в индексе сопоставления.
type entry struct {
	key       string // нормализованное название
	stems     []string
	words     []string
	canon     string
	canonical bool // само каноническое название
	ambiguous bool // однословное и входит в название другого вида (правило 2)
}

// matchIndex — названия по убыванию числа слов (правило 1).
type matchIndex struct {
	entries []entry
}

// index — индекс сопоставления, строится из Canon при первом вызове: словарь
// можно собрать и литералом (тесты, другой источник названий).
func (a *Aliases) index() *matchIndex {
	a.once.Do(func() {
		ix := &matchIndex{}
		for key, canon := range a.Canon {
			var stems, words []string
			for _, t := range tokenize(key) {
				stems = append(stems, t.stem)
				words = append(words, t.word)
			}
			if len(stems) == 0 {
				continue
			}
			ix.entries = append(ix.entries, entry{key: key, stems: stems, words: words, canon: canon,
				canonical: key == corpus.Normalize(canon)})
		}
		for i := range ix.entries {
			e := &ix.entries[i]
			if len(e.stems) != 1 || e.canonical {
				continue
			}
		other:
			for _, o := range ix.entries {
				if o.canon == e.canon {
					continue
				}
				for _, s := range o.stems {
					if sameStem(s, e.stems[0]) {
						e.ambiguous = true
						break other
					}
				}
			}
		}
		sort.Slice(ix.entries, func(i, j int) bool {
			x, y := ix.entries[i], ix.entries[j]
			if len(x.stems) != len(y.stems) {
				return len(x.stems) > len(y.stems)
			}
			return x.key < y.key
		})
		a.ix = ix
	})
	return a.ix
}

// found — название, найденное в тексте.
type found struct {
	from, to  int // слова [from, to)
	canon     string
	canonical bool
	surface   string // как написано в тексте
}

// matches — названия видов в тексте по правилам 1–3, по порядку в тексте.
func (a *Aliases) matches(text string) []found {
	if a == nil || len(a.Canon) == 0 {
		return nil
	}
	ix := a.index()
	toks := tokenize(text)
	used := make([]bool, len(toks))
	var out []found
	for _, e := range ix.entries {
		n := len(e.stems)
	scan:
		for i := 0; i+n <= len(toks); i++ {
			for j := 0; j < n; j++ {
				if used[i+j] || !sameStem(toks[i+j].stem, e.stems[j]) {
					continue scan
				}
			}
			if n == 1 && !e.canonical && (e.ambiguous || modifierBefore(toks, i)) {
				continue
			}
			if n == 1 && utf8.RuneCountInString(e.stems[0]) < 4 && toks[i].word != e.words[0] {
				// Правило 5: однословное название с основой короче четырёх
				// букв — только точной формой: «долю» не «долов».
				continue
			}
			for j := i; j < i+n; j++ {
				used[j] = true
			}
			out = append(out, found{from: i, to: i + n, canon: e.canon, canonical: e.canonical,
				surface: text[toks[i].from:toks[i+n-1].to]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].from < out[j].from })
	return out
}

// modifierBefore — перед словом i стоит определение (правило 3).
func modifierBefore(toks []token, i int) bool {
	if i == 0 {
		return false
	}
	w := toks[i-1].word
	if determiners[w] || utf8.RuneCountInString(w) < 4 {
		return false
	}
	for _, e := range adjEndings {
		if strings.HasSuffix(w, e) {
			return true
		}
	}
	return false
}

// LoadAliases — словарь из документов базы (kb.Store.Doc → Species).
// Канон — Species.Ru (пусто — заголовок документа строчными); синонимы —
// сам канон, Species.Aliases, латынь и заголовок документа. Синоним,
// который у двух видов разный, выбрасывается: раскрывать его не во что.
func LoadAliases(ctx context.Context, st *kb.Store) (*Aliases, error) {
	infos, err := st.Docs(ctx)
	if err != nil {
		return nil, err
	}
	var docs []corpus.Doc
	for _, d := range infos {
		doc, err := st.Doc(ctx, d.ID)
		if err != nil {
			return nil, err
		}
		docs = append(docs, doc)
	}
	return AliasesOf(docs), nil
}

// AliasesOf — словарь из документов корпуса (для тестов и corpus.Load;
// добавление к контракту).
func AliasesOf(docs []corpus.Doc) *Aliases {
	a := &Aliases{Canon: map[string]string{}, Latin: map[string]string{}}
	bad := map[string]bool{}
	put := func(name, canon string) {
		k := corpus.Normalize(name)
		if k == "" || bad[k] {
			return
		}
		if prev, ok := a.Canon[k]; ok && prev != canon {
			delete(a.Canon, k)
			bad[k] = true
			return
		}
		a.Canon[k] = canon
	}
	for _, d := range docs {
		sp := d.Species
		if sp == nil {
			continue
		}
		canon := strings.TrimSpace(sp.Ru)
		if canon == "" {
			canon = strings.ToLower(strings.TrimSpace(d.Title))
		}
		if canon == "" {
			continue
		}
		put(canon, canon)
		for _, x := range sp.Aliases {
			put(x, canon)
		}
		if sp.Latin != "" {
			put(sp.Latin, canon)
			a.Latin[canon] = sp.Latin
		}
		put(d.Title, canon)
	}
	return a
}

// Expand — запрос с раскрытыми синонимами и список раскрытого. Канон уже в
// запросе — ничего не добавляется. К запросу дописываются канон и латынь
// раскрытого вида: «Сколько весит кошачий медведь? малая панда Ailurus
// fulgens»; в списке — «кошачий медведь → малая панда».
func (a *Aliases) Expand(q string) (string, []string) {
	ms := a.matches(q)
	named := map[string]bool{}
	for _, m := range ms {
		if m.canonical {
			named[m.canon] = true
		}
	}
	var add, list []string
	for _, m := range ms {
		if m.canonical || named[m.canon] {
			continue
		}
		named[m.canon] = true
		list = append(list, m.surface+" → "+m.canon)
		add = append(add, m.canon)
		if lat := a.Latin[m.canon]; lat != "" && !containsFold(q, lat) {
			add = append(add, lat)
		}
	}
	if len(add) == 0 {
		return q, nil
	}
	return strings.TrimSpace(q) + " " + strings.Join(add, " "), list
}

// Species — канонические названия видов, упомянутых в тексте, по порядку
// первого упоминания (для вопросов-продолжений: вид из контекста).
func (a *Aliases) Species(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range a.matches(text) {
		if !seen[m.canon] {
			seen[m.canon] = true
			out = append(out, m.canon)
		}
	}
	return out
}

func containsFold(s, sub string) bool {
	return strings.Contains(corpus.Normalize(s), corpus.Normalize(sub))
}
