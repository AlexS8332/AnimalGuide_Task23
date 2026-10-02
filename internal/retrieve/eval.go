package retrieve

import (
	"time"
)

// Named — конфигурация с именем для матрицы режимов.
type Named struct {
	Name   string `json:"name"` // "base", "filter", "rewrite", "both", "hybrid", "llm-rerank", "llm-rewrite"
	Config Config `json:"config"`
}

// MatrixRow — метрики поиска одной конфигурации на наборе.
type MatrixRow struct {
	Name  string `json:"name"`
	Split string `json:"split"`
	K1    int    `json:"k1"`
	N     int    `json:"n"`
	// RecallBefore — доказательство среди K0 кандидатов; RecallAfter — среди
	// итоговых K1 (то, что увидит модель).
	RecallBefore float64 `json:"recall_before"`
	RecallAfter  float64 `json:"recall_after"`
	MRR          float64 `json:"mrr"`
	// Precision — доля итоговых фрагментов, покрывающих доказательство
	// (≥ kb.EvidenceCover) хотя бы одного доказательства вопроса.
	Precision float64 `json:"precision"`
	// CutShare — доля кандидатов K0, отсечённых фильтром; WrongCut — доля
	// вопросов, у которых доказательство было среди кандидатов, но отсечено.
	CutShare float64 `json:"cut_share"`
	WrongCut float64 `json:"wrong_cut"`
	// OutEmpty — на неотвечаемых (out и answerable=false): доля вопросов,
	// где после фильтра не осталось ничего.
	OutEmpty float64 `json:"out_empty"`
	OutN     int     `json:"out_n"`
	Tokens   float64 `json:"tokens"` // среднее токенов итоговых фрагментов
	Millis   float64 `json:"ms"`
	CostUSD  float64 `json:"cost_usd"`
	// Rows — по вопросу: ранг доказательства до и после, оставлено, пусто ли.
	Rows []MatrixQ `json:"rows"`
}

// MatrixQ — вопрос в строке матрицы.
type MatrixQ struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Rewritten string `json:"rewritten,omitempty"`
	RankBefor int    `json:"rank_before"` // в кандидатах; 0 — нет
	RankAfter int    `json:"rank_after"`  // в итоге; 0 — нет
	Kept      int    `json:"kept"`
	Empty     bool   `json:"empty"`
	// Answerable — у вопроса есть ответ в базе и доказательство найдено в
	// тексте документа (входит в N); иначе вопрос — в OutN, если он
	// неотвечаемый (добавление v23).
	Answerable bool `json:"answerable"`
	// Unanswerable — вопрос без ответа в базе (out и answerable=false).
	Unanswerable bool `json:"unanswerable,omitempty"`
}

// Matrix — сравнение конфигураций на наборах и при разных K1 (без модели,
// кроме платных строк).
type Matrix struct {
	Created   time.Time   `json:"created"`
	CorpusSHA string      `json:"corpus_sha"`
	Embedder  string      `json:"embedder"`
	Index     string      `json:"index"`
	MinScore  float64     `json:"min_score"`
	Delta     float64     `json:"delta"`
	Rows      []MatrixRow `json:"rows"`
	// Conclusion — вывод кодом, числами, с вопросами вместо долей там, где
	// выборка мала.
	Conclusion []string `json:"conclusion"`
	// K0 — кандидатов; Fallback — почему поиск шёл не по векторам (пусто —
	// по векторам); Configs — сравниваемые конфигурации (добавления v23).
	K0       int     `json:"k0"`
	Fallback string  `json:"fallback,omitempty"`
	Configs  []Named `json:"configs"`
}

// CalibRow — порог и его последствия на dev+out.
type CalibRow struct {
	MinScore float64 `json:"min_score"`
	// DevRecall — доказательство в итоге на dev (answerable); OutEmpty — доля
	// out, где всё отсечено; LostDev — dev-вопросы, у которых фильтр отсёк
	// доказательство.
	DevRecall float64  `json:"dev_recall"`
	OutEmpty  float64  `json:"out_empty"`
	LostDev   []string `json:"lost_dev,omitempty"`
}

// Calibration — подбор абсолютного порога на dev+out: перебор MinScore с
// шагом 0.005; выбирается наибольший порог, при котором recall на dev
// падает не больше чем на MaxDrop против «без фильтра». Test не
// используется.
type Calibration struct {
	Index    string     `json:"index"`
	Embedder string     `json:"embedder"`
	Delta    float64    `json:"delta"`
	MaxDrop  float64    `json:"max_drop"`
	Base     float64    `json:"base_recall"` // dev без фильтра
	Chosen   float64    `json:"chosen"`
	Table    []CalibRow `json:"table"`
	// Hist — косинусы лучшего кандидата: у отвечаемых dev и у out (для
	// гистограммы в отчёте и окне).
	DevTop []float64 `json:"dev_top"`
	OutTop []float64 `json:"out_top"`
	// Created, DevN, OutN, Written, Note — когда, сколько вопросов, записан
	// ли порог в индекс и оговорки (добавления v23).
	Created time.Time `json:"created"`
	DevN    int       `json:"dev_n"`
	OutN    int       `json:"out_n"`
	Written bool      `json:"written"`
	// Anchored — вопросы, в запросе которых назван вид корпуса: пол к ним
	// не применяется (Trace.Anchored).
	Anchored []string `json:"anchored,omitempty"`
	Note     string   `json:"note,omitempty"`
}
