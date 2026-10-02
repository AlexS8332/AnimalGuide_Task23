'use strict';

/* Окно «База знаний» (v21–v22): корпус, чанки документа в двух
   стратегиях, поиск по двум индексам рядом, ответ модели с базой и без
   неё, прогон контрольных вопросов и последний отчёт сравнения стратегий.
   Подключается после app.js и пользуется его общими помощниками (app, esc,
   actions, factsAPI, factsURL, num, plural, toast).

   Вкладка «Корпус» — манифест (документы, страницы, символы, corpus_sha,
   лицензии), индексы базы, статус эмбеддера и таблица документов; клик по
   документу открывает его чанки. «Чанки» — канонический текст документа,
   где каждый чанк — блок своего фона с подписью (chunk_id, путь раздела,
   токены, «на стыке разделов»); перекрытие fixed подсвечено штриховкой.
   «Поиск» — один запрос сразу в оба индекса, выдачи рядом; клик по
   попаданию ведёт к чанку. «Сравнение» — таблицы последнего отчёта
   `kb eval` и вывод числами.

   v22: «Спросить» — один вопрос в режимах norag и rag, ответы рядом;
   у rag — найденные фрагменты, ссылки [chunk_id] в ответе ведут к чанку;
   вопрос из набора оценивается правилом. «Контрольные вопросы» — прогон
   набора test в обоих режимах: строки заполняются по мере готовности
   (опрос /api/kb/evals/{id}), итог — сводка режимов рядом и вывод.

   Всё, что пришло из корпуса (заголовки, тексты, разделы, причины), —
   данные, а не разметка: только через esc(). Стабильные id и классы
   (#kb-button, [data-kb-tab], #kb-docs, .kb-doc[data-doc], #kb-chunks,
   #kb-doc, #kb-strategy, .kb-chunk[data-id], #kb-search, #kb-q, #kb-k,
   #kb-mode, #kb-go, .kb-result[data-index], .kb-hit[data-chunk],
   #kb-report, #kb-off; v22: #kb-ask, #kb-ask-q, #kb-ask-pick, #kb-ask-go,
   .kb-thinking, .kb-answer[data-mode], .kb-src[data-chunk], .kb-cite,
   .kb-verdict[data-mode][data-verdict], #kb-ask-prompt, #kb-qa,
   #kb-qa-run, .kb-qa-row[data-id], #kb-qa-summary, #kb-qa-runs) — для
   сценариев проверок и записи. Ответы модели — тоже данные: esc(). */

const kb = {
  tab: 'docs',          // docs | chunks | search | ask | qa | report
  info: null,           // {ok, code, data, error} — GET /api/kb/info
  docs: null,           // {ok, code, data, error} — GET /api/kb/docs
  doc: '',              // документ вкладки «Чанки»
  strategy: 'structure',
  views: {},            // `${doc}|${index}` → {ok, code, data, error} — GET /api/kb/docs/{id}?index=
  focus: '',            // chunk_id, к которому прокрутить вкладку «Чанки»
  form: { q: '', k: 5, mode: 'dense' },
  result: null,         // {ok, code, data, error} — GET /api/kb/search
  searching: false,
  report: null,         // {ok, code, data, error} — GET /api/kb/report
  // v22
  questions: null,      // {ok, code, data, error} — GET /api/kb/questions
  askForm: { q: '', qid: '' },
  ask: null,            // {ok, code, data, error} — POST /api/kb/ask
  asking: false,
  qaForm: { repeats: 1, judge: true },
  evals: null,          // {ok, code, data, error} — GET /api/kb/evals
  eval: null,           // EvalView открытого прогона
  evalError: null,      // {code, text, id, why, hint} — ошибка запуска или опроса
  starting: false,
  stopping: false,      // идёт DELETE прогона
  qaOpen: {},           // id вопроса → раскрыта строка
  pollMs: 700,
  timer: null,
  seq: 0,
};
app.kb = kb;

const kbTabs = [
  ['docs', 'Корпус', 'документы корпуса, индексы и эмбеддер'],
  ['chunks', 'Чанки', 'текст документа и границы чанков в двух стратегиях'],
  ['search', 'Поиск', 'один запрос в оба индекса — выдачи рядом'],
  ['ask', 'Спросить', 'ответ модели без базы и с базой — рядом'],
  ['qa', 'Контрольные вопросы', 'прогон набора test в обоих режимах и сравнение'],
  ['report', 'Сравнение', 'последний отчёт сравнения стратегий (kb eval)'],
];
const kbStrategyText = { structure: 'structure — по разделам', fixed: 'fixed — окно с перекрытием' };
const kbBuild = 'go run ./cmd/kb index -strategy all';
const kbEval = 'go run ./cmd/kb eval';

/* ---------- мелочи ---------- */

const kbList = v => (Array.isArray(v) ? v : []);
function kbCut(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function kbPct(f) { return typeof f === 'number' && isFinite(f) ? (100 * f).toFixed(1) + ' %' : '—'; }
function kbNum2(f) { return typeof f === 'number' && isFinite(f) ? f.toFixed(2) : '—'; }
function kbShort(sha) { return String(sha || '').slice(0, 12); }
function kbPages(p) { return typeof p === 'number' && isFinite(p) ? p.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—'; }
// kbOldURL — постоянная ссылка на ревизию статьи (…/w/index.php?oldid=),
// иначе адрес документа; только http/https.
function kbOldURL(d) {
  const u = factsURL(d.url);
  if (!u || !d.revid) return u;
  try { return new URL('/w/index.php?oldid=' + encodeURIComponent(d.revid), u).href; } catch (e) { return u; }
}
function kbParams(p) {
  p = p || {};
  if (p.size) return `size ${p.size}, overlap ${p.overlap || 0}`;
  if (p.max) return `max ${p.max}, min ${p.min || 0}`;
  return '—';
}
function kbPath(c) { return kbList(c.section_path).join(' › ') || c.section || ''; }
function kbBase() { return !!(kb.info && kb.info.ok); }
function kbIndexes() { return kbBase() ? kbList(kb.info.data.indexes) : []; }
function kbDocList() { return kb.docs && kb.docs.ok ? kbList(kb.docs.data) : []; }
function kbDocInfo(id) { return kbDocList().find(d => d.doc_id === id) || null; }
function kbStrategies() {
  const ids = kbIndexes().map(x => x.index_id);
  return ids.length ? ids : ['structure', 'fixed'];
}

/* ---------- загрузка ---------- */

async function kbLoadInfo() {
  kb.info = await factsAPI('GET', '/api/kb/info');
  kbRenderButton();
}
async function kbLoadDocs() {
  if (!kbBase()) return;
  kb.docs = await factsAPI('GET', '/api/kb/docs');
  if (!kb.doc && kbDocList().length) kb.doc = kbDocList()[0].doc_id;
}
async function kbLoadReport() { kb.report = kbBase() ? await factsAPI('GET', '/api/kb/report') : null; }
// kbLoadDoc — документ в обеих стратегиях: переключатель меняет вид
// мгновенно, а сводка сравнивает числа чанков.
async function kbLoadDoc(id) {
  if (!id || !kbBase()) return;
  await Promise.all(kbStrategies().map(async s => {
    const key = id + '|' + s;
    if (kb.views[key] && kb.views[key].ok) return;
    kb.views[key] = await factsAPI('GET', '/api/kb/docs/' + encodeURIComponent(id) + '?index=' + encodeURIComponent(s));
  }));
}

/* ---------- кнопка на пульте ---------- */

// Рядом с «MCP-серверы»: точка — база и эмбеддер (зелёная — dense,
// янтарная — эмбеддер не отвечает, поиск по BM25, кирпичная — базы нет).
function kbRenderButton() {
  let btn = $('kb-button');
  if (!btn) {
    const anchor = $('windows-button');
    if (!anchor) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'kb-button';
    btn.className = 'ghost kb-button';
    btn.dataset.action = 'openWindow';
    btn.dataset.arg = 'kb';
    // В конец ряда: кнопки «Факты» и «MCP-серверы» встают сразу за «Окна ▾»
    // по мере ответов своих разделов, «База знаний» остаётся последней.
    anchor.parentElement.appendChild(btn);
  }
  const r = kb.info;
  let cls = '', lines = ['База знаний: корпус, чанки, поиск по двум индексам, сравнение стратегий'];
  if (r && r.ok) {
    const emb = r.data.embedder || {};
    cls = emb.ok ? 'ok' : 'warn';
    lines.push(`документов ${r.data.docs}, индексов ${kbList(r.data.indexes).length}`);
    lines.push(emb.ok ? 'эмбеддер: ' + (emb.model || '') : 'эмбеддер не отвечает — поиск по BM25');
  } else if (r) {
    cls = 'bad';
    lines.push(r.code === 404 ? 'сервер приложения не знает /api/kb' : (r.data && r.data.why) || r.error);
  }
  btn.innerHTML = `<span class="kb-dot ${cls}"></span>База знаний`;
  btn.title = lines.join('\n');
}

/* ---------- окно ---------- */

app.windows.kb = {
  title: 'База знаний',
  async render() {
    await kbLoadInfo();
    await kbLoadDocs();
    await kbLoadTab();
    if (kb.focus) setTimeout(kbScrollFocus, 0); // после отрисовки окна
    return `<div id="kb-root" class="kb">
      <div class="tabs kb-tabs" id="kb-tabs">${kbTabsHTML()}</div>
      <div id="kb-body" class="kb-body">${kbBodyHTML()}</div>
    </div>`;
  },
};

// kbLoadTab — что нужно открытой вкладке.
async function kbLoadTab() {
  if (!kbBase()) return;
  if (kb.tab === 'chunks') await kbLoadDoc(kb.doc);
  if (kb.tab === 'report' && (!kb.report || !kb.report.ok)) await kbLoadReport();
  if (kb.tab === 'ask' || kb.tab === 'qa') await kbLoadQuestions();
  if (kb.tab === 'qa') await kbLoadEvals(true);
}

function kbTabsHTML() {
  return kbTabs.map(([id, label, title]) => {
    let n = '';
    if (id === 'docs' && kbBase()) n = ' · ' + kb.info.data.docs;
    return `<button type="button" class="tab${kb.tab === id ? ' active' : ''}" data-action="kbTab" data-arg="${id}" data-kb-tab="${id}" id="kb-tab-${id}" title="${esc(title)}">${esc(label + n)}</button>`;
  }).join('');
}

function kbBodyHTML() {
  if (!kb.info) return '<p class="hint">загружаю…</p>';
  if (!kb.info.ok) return kbOffHTML();
  switch (kb.tab) {
    case 'chunks': return kbChunksHTML();
    case 'search': return kbSearchHTML();
    case 'report': return kbReportHTML();
    case 'ask': return kbAskHTML();
    case 'qa': return kbQaHTML();
    default: return kbDocsHTML();
  }
}

function kbPaint(...parts) {
  if (!$('kb-root')) return;
  if (parts.includes('tabs')) $('kb-tabs').innerHTML = kbTabsHTML();
  if (parts.includes('body')) $('kb-body').innerHTML = kbBodyHTML();
  if (parts.includes('results') && $('kb-results')) $('kb-results').outerHTML = kbResultsHTML();
  if (parts.includes('ask') && $('kb-ask-out')) $('kb-ask-out').outerHTML = kbAskOutHTML();
  if (parts.includes('qa') && $('kb-qa-live')) $('kb-qa-live').outerHTML = kbQaLiveHTML();
  if (parts.includes('runs') && $('kb-qa-runs')) $('kb-qa-runs').outerHTML = kbQaRunsHTML();
  const go = $('kb-go');
  if (go) { go.disabled = kb.searching; go.innerHTML = kb.searching ? '<span class="thinking">ищу</span>' : 'Найти'; }
  const ask = $('kb-ask-go');
  if (ask) { ask.disabled = kb.asking; ask.innerHTML = kb.asking ? '<span class="thinking">думает</span>' : 'Спросить'; }
  const run = $('kb-qa-run');
  if (run) run.disabled = kbQaRunning() || kb.starting;
  const stop = $('kb-qa-stop');
  if (stop) stop.hidden = !kbQaRunning() || kb.stopping;
}

// kbOffHTML — базы нет (503) или сервер не знает /api/kb.
function kbOffHTML() {
  const r = kb.info;
  const d = r.data || {};
  if (r.code === 404) {
    return `<div class="facts-down kb-off" id="kb-off"><b>База знаний недоступна.</b><div>сервер приложения не знает /api/kb — обновите приложение</div></div>`;
  }
  return `<div class="facts-down kb-off" id="kb-off">
    <b>Базы знаний нет.</b>
    <div class="kb-why">${esc(d.why || r.error)}</div>
    ${d.hint ? `<div class="facts-hint">${esc(d.hint)}</div>` : ''}
    <div class="kb-steps">Как собрать:
      <ol>
        <li>эмбеддер (по желанию): <code>uv run embedder/server.py</code> — без него индекс соберётся только для BM25;</li>
        <li>индекс обеих стратегий: <code>${esc(kbBuild)}</code>;</li>
        <li>отчёт сравнения: <code>${esc(kbEval)}</code>;</li>
        <li>перезапустите приложение и откройте окно снова.</li>
      </ol></div>
    ${d.embedder ? `<div class="hint kb-off-emb">эмбеддер: ${esc(d.embedder.ok ? (d.embedder.model || '') + ' отвечает' : 'не отвечает — ' + (d.embedder.why || ''))}</div>` : ''}
    ${d.path ? `<div class="hint">база ищется здесь: <code>${esc(d.path)}</code> (флаг -kb или KB_DB)</div>` : ''}
  </div>`;
}

/* ---------- вкладка «Корпус» ---------- */

function kbEmbedderHTML(e) {
  e = e || {};
  if (e.ok) {
    return `<div class="kb-emb ok" id="kb-embedder"><span class="kb-dot ok"></span>
      <span>Эмбеддер <b>${esc(e.model || '')}</b>${e.device ? ' · ' + esc(e.device) : ''}${e.dims ? ' · ' + esc(e.dims) + ' изм.' : ''}</span>
      <span class="hint">${esc(e.url || '')}</span></div>`;
  }
  return `<div class="kb-emb bad" id="kb-embedder"><span class="kb-dot warn"></span>
    <span><b>Эмбеддер не отвечает — поиск по BM25.</b> ${esc(e.why || '')}</span>
    ${e.hint ? `<div class="facts-hint">${esc(e.hint)}</div>` : ''}</div>`;
}

function kbDocsHTML() {
  const v = kb.info.data;
  const m = v.manifest || {};
  const docs = kbDocList();
  const licenses = [...new Set(docs.map(d => d.license).filter(Boolean))];
  const chars = m.chars || docs.reduce((s, d) => s + (d.chars || 0), 0);
  let html = `<div id="kb-docs" class="kb-docs">
    <div class="kb-stats" id="kb-stats">
      <div class="kb-stat"><span>документов</span><b id="kb-n-docs">${esc(v.docs)}</b></div>
      <div class="kb-stat"><span>страниц</span><b id="kb-n-pages">${esc(kbPages(v.pages))}</b></div>
      <div class="kb-stat"><span>символов</span><b id="kb-n-chars">${esc(num(chars))}</b></div>
      <div class="kb-stat"><span>corpus_sha</span><b><code id="kb-sha" title="${esc(m.corpus_sha || '')}">${esc(kbShort(m.corpus_sha) || '—')}</code></b></div>
      <div class="kb-stat wide"><span>лицензии</span><b id="kb-licenses">${licenses.map(l => `<span class="chip">${esc(l)}</span>`).join(' ') || '—'}</b></div>
    </div>
    ${kbEmbedderHTML(v.embedder)}
    <div class="kb-indexes" id="kb-indexes">${kbIndexes().map(x => `<span class="kb-index" data-index="${esc(x.index_id)}">
      <b>${esc(x.index_id)}</b> ${esc(num(x.chunks))} чанков · ${esc(kbParams(x.params))} · ${esc(x.embedder || 'без векторов')}${x.dims ? ' · ' + esc(x.dims) + ' изм.' : ''}</span>`).join('') ||
      `<span class="hint">индексов нет — соберите: <code>${esc(kbBuild)}</code></span>`}</div>`;
  if (kb.docs && !kb.docs.ok) return html + `<div class="facts-error">${esc(kb.docs.error)}</div></div>`;
  html += `<table class="grid kb-doc-table" id="kb-doc-table"><tr><th>№</th><th>документ</th><th>источник</th><th class="kb-r">символов</th><th class="kb-r">страниц</th><th>revid</th><th>лицензия</th></tr>
    ${docs.map((d, i) => {
      const u = kbOldURL(d);
      return `<tr class="kb-doc" data-doc="${esc(d.doc_id)}" data-action="kbOpenDoc" data-arg="${esc(d.doc_id)}" title="чанки документа">
        <td class="kb-r hint">${i + 1}</td>
        <td><b class="kb-doc-title">${esc(d.title)}</b> <span class="hint">${esc(d.doc_id)}</span></td>
        <td>${esc(d.source)}</td>
        <td class="kb-r">${esc(num(d.chars))}</td><td class="kb-r">${esc(kbPages(d.pages))}</td>
        <td>${u ? `<a class="kb-ext" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(d.revid || 'ссылка')} ↗</a>` : esc(d.revid || '—')}</td>
        <td class="hint">${esc(d.license)}</td></tr>`;
    }).join('')}</table>`;
  return html + '</div>';
}

// Ссылка на ревизию внутри строки документа — переход, а не «открыть чанки»:
// общий обработчик app.js отменяет переход у элементов внутри data-action.
document.addEventListener('click', ev => {
  if (ev.target.closest && ev.target.closest('a.kb-ext')) ev.stopPropagation();
}, true);

/* ---------- вкладка «Чанки» ---------- */

function kbChunksHTML() {
  const docs = kbDocList();
  const strategies = kbStrategies();
  let html = `<div id="kb-chunks" class="kb-chunks">
    <div class="kb-bar">
      <label class="lbl" for="kb-doc">документ</label>
      <select id="kb-doc" data-change="kbPickDoc">${docs.map(d => `<option value="${esc(d.doc_id)}"${d.doc_id === kb.doc ? ' selected' : ''}>${esc(d.title)}</option>`).join('')}</select>
      <label class="lbl" for="kb-strategy">стратегия</label>
      <select id="kb-strategy" data-change="kbPickStrategy">${strategies.map(s => `<option value="${esc(s)}"${s === kb.strategy ? ' selected' : ''}>${esc(kbStrategyText[s] || s)}</option>`).join('')}</select>
      <span class="kb-seg">${strategies.map(s => `<button type="button" class="small${s === kb.strategy ? ' on' : ''}" data-action="kbPickStrategy" data-arg="${esc(s)}" data-kb-strategy="${esc(s)}">${esc(s)}</button>`).join('')}</span>
    </div>`;
  if (!kb.doc) return html + '<p class="hint">Документов в базе нет.</p></div>';
  const r = kb.views[kb.doc + '|' + kb.strategy];
  if (!r) return html + '<p class="hint">загружаю…</p></div>';
  if (!r.ok) return html + `<div class="facts-error" id="kb-doc-error">${esc(r.error)}</div></div>`;
  html += kbChunkSummaryHTML(r.data);
  html += `<div class="kb-text" id="kb-text" data-doc="${esc(kb.doc)}" data-index="${esc(r.data.index)}">${kbTextHTML(r.data)}</div>`;
  return html + '</div>';
}

// kbChunkSummaryHTML — сводка по документу: чанков в каждой стратегии,
// сколько на стыке разделов, медиана токенов.
function kbChunkSummaryHTML(v) {
  const d = v.doc || {};
  const u = kbOldURL(d);
  const cells = kbStrategies().map(s => {
    const r = kb.views[kb.doc + '|' + s];
    if (!r || !r.ok) return `<span class="kb-sum-s" data-index="${esc(s)}"><b>${esc(s)}</b> —</span>`;
    const cs = kbList(r.data.chunks);
    const mixed = cs.filter(c => c.mixed).length;
    const toks = cs.map(c => c.tokens || 0).sort((a, b) => a - b);
    const p50 = toks.length ? toks[Math.floor((toks.length - 1) / 2)] : 0;
    return `<span class="kb-sum-s${s === kb.strategy ? ' on' : ''}" data-index="${esc(s)}"><b>${esc(s)}</b>
      <span class="kb-sum-n">${esc(plural(cs.length, 'чанк', 'чанка', 'чанков'))}</span>, на стыке разделов ${esc(mixed)}, p50 ${esc(p50)} ток.</span>`;
  }).join('');
  return `<div class="kb-summary" id="kb-summary">
    <div class="kb-sum-doc"><b>${esc(d.title || kb.doc)}</b> <span class="hint">${esc(num(d.chars))} символов · ${esc(kbPages(d.pages))} стр.</span>
      ${u ? `<a class="kb-ext" href="${esc(u)}" target="_blank" rel="noopener noreferrer">ревизия ${esc(d.revid || '')} ↗</a>` : ''}</div>
    <div class="kb-sum-row">${cells}</div>
  </div>`;
}

// kbPlain — кусок текста документа: строки «## Путь › Раздел» —
// заголовками; всё — через esc().
function kbPlain(s) {
  return s.split('\n').map(line => line.startsWith('## ')
    ? `<span class="kb-hd">${esc(line.slice(3))}</span>` : esc(line)).join('\n');
}

// kbTextHTML — текст документа блоками чанков. Смещения — в рунах, поэтому
// текст режется по кодовым точкам. Каждая руна текста выводится один раз:
// перекрытие fixed (начало чанка внутри предыдущего) остаётся в хвосте
// предыдущего блока и подсвечено; промежутки между чанками (заголовки,
// пустые строки) — обычный текст.
function kbTextHTML(v) {
  const t = Array.from(v.text || '');
  const cs = kbList(v.chunks).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const piece = (a, b) => t.slice(a, b).join('');
  // Промежуток между блоками — без крайних переводов строк: блок и так с новой строки.
  const gap = (a, b) => {
    const s = piece(a, b).replace(/^\n+|\n+$/g, '');
    return s.trim() ? `<div class="kb-gap">${kbPlain(s)}</div>` : '';
  };
  let pos = 0;
  let html = '';
  cs.forEach((c, i) => {
    const start = Math.max(c.start, pos);
    const end = Math.min(Math.max(c.end, start), t.length);
    if (start > pos) html += gap(pos, start);
    const next = cs[i + 1];
    const ov = next && next.start < end ? Math.max(next.start, start) : end;
    const tags = [];
    if (c.mixed) tags.push('<span class="chip warn kb-mixed">на стыке разделов</span>');
    if (ov < end) tags.push(`<span class="chip kb-ovl">перекрытие ${esc(end - ov)} симв.</span>`);
    html += `<div class="kb-chunk ${i % 2 ? 'odd' : 'even'}${c.mixed ? ' mixed' : ''}${c.chunk_id === kb.focus ? ' focus' : ''}" data-id="${esc(c.chunk_id)}" data-ord="${esc(c.ord)}">
      <div class="kb-chunk-head"><code class="kb-cid">${esc(c.chunk_id)}</code><span class="kb-cpath">${esc(kbPath(c))}</span><span class="kb-ctok">${esc(c.tokens)} ток. · ${esc(c.start)}–${esc(c.end)}</span>${tags.join('')}</div>
      <div class="kb-chunk-text">${kbPlain(piece(start, ov).replace(/^[ \t]+/, ''))}${ov < end ? `<span class="kb-overlap" title="этот текст входит и в следующий чанк">${kbPlain(piece(ov, end))}</span>` : ''}</div></div>`;
    pos = Math.max(pos, end);
  });
  if (pos < t.length) html += gap(pos, t.length);
  if (!cs.length) html += '<p class="hint">В этом индексе у документа нет чанков.</p>';
  return html;
}

function kbScrollFocus() {
  if (!kb.focus || !$('kb-text')) return;
  const el = [...document.querySelectorAll('#kb-text .kb-chunk')].find(x => x.dataset.id === kb.focus);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

async function kbShowChunks(paintFirst) {
  if (kb.tab !== 'chunks') return;
  if (paintFirst) kbPaint('body');
  await kbLoadDoc(kb.doc);
  if (kb.tab !== 'chunks') return;
  kbPaint('body');
  kbScrollFocus();
}

/* ---------- вкладка «Поиск» ---------- */

function kbSearchHTML() {
  const f = kb.form;
  const ks = [1, 3, 5, 8, 10, 20];
  return `<div id="kb-search" class="kb-search">
    <form id="kb-search-form" class="kb-form" data-submit="kbSearch" autocomplete="off">
      <input type="text" id="kb-q" value="${esc(f.q)}" placeholder="чем питается харза" maxlength="500">
      <label class="lbl" for="kb-k">k</label>
      <select id="kb-k">${ks.map(k => `<option value="${k}"${k === f.k ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <label class="lbl" for="kb-mode">режим</label>
      <select id="kb-mode">
        <option value="dense"${f.mode === 'dense' ? ' selected' : ''}>dense — векторы</option>
        <option value="bm25"${f.mode === 'bm25' ? ' selected' : ''}>BM25 — слова</option>
      </select>
      <button type="submit" class="solid" id="kb-go"${kb.searching ? ' disabled' : ''}>${kb.searching ? '<span class="thinking">ищу</span>' : 'Найти'}</button>
    </form>
    <div class="hint">Запрос уходит сразу в оба индекса — выдачи рядом. dense без эмбеддера откатывается на BM25 и говорит об этом. Клик по попаданию — к чанку в тексте документа.</div>
    ${kbResultsHTML()}
  </div>`;
}

function kbModeLine(info) {
  info = info || {};
  if (info.mode === 'dense') return `<span class="kb-mode dense">dense · ${esc(info.embedder || '')}</span>`;
  if (info.fallback) return `<span class="kb-mode fallback" title="${esc(info.fallback)}">BM25 — откат: ${esc(info.fallback)}</span>`;
  return `<span class="kb-mode bm25">BM25</span>`;
}

function kbResultsHTML() {
  const r = kb.result;
  if (!r) return '<div id="kb-results" class="kb-results-empty hint">Введите вопрос — например, «чем питается харза».</div>';
  if (!r.ok) return `<div id="kb-results"><div class="facts-error" id="kb-search-error">${esc(r.error)}</div></div>`;
  const res = kbList(r.data.results);
  return `<div id="kb-results" class="kb-results" data-query="${esc(r.data.query)}" style="--kb-cols:${Math.max(1, Math.min(res.length, 3))}">${res.map(x => {
    const info = x.info || {};
    const hits = kbList(x.hits);
    return `<section class="kb-result" data-index="${esc(info.index)}" data-mode="${esc(info.mode || '')}">
      <div class="kb-result-head"><b>${esc(info.index)}</b>${kbModeLine(info)}<span class="hint">${esc(typeof info.ms === 'number' ? info.ms.toFixed(1) + ' мс' : '')}</span></div>
      ${x.error ? `<div class="facts-error">${esc(x.error)}</div>` : ''}
      ${hits.length ? hits.map(h => `<div class="kb-hit" data-chunk="${esc(h.chunk_id)}" data-doc="${esc(h.doc_id)}" data-index="${esc(info.index)}" data-action="kbOpenChunk" data-arg="${esc(h.chunk_id)}" title="открыть чанк в тексте документа">
        <div class="kb-hit-head"><span class="kb-rank">${esc(h.rank)}</span><span class="kb-score">${esc(typeof h.score === 'number' ? h.score.toFixed(3) : '')}</span>
          <span class="kb-hit-where"><b>${esc(h.title)}</b> › ${esc(kbPath(h))}</span></div>
        <div class="kb-hit-text">${esc(kbCut(h.text, 300))}</div>
        <div class="kb-hit-foot"><code>${esc(h.chunk_id)}</code> · ${esc(h.tokens)} ток.${h.mixed ? ' · <span class="kb-mixed-t">на стыке разделов</span>' : ''}</div>
      </div>`).join('') : (x.error ? '' : '<p class="hint">Ничего не нашлось.</p>')}
    </section>`;
  }).join('')}</div>`;
}

function kbReadForm() {
  const q = $('kb-q'), k = $('kb-k'), m = $('kb-mode');
  if (q) kb.form.q = q.value;
  if (k) kb.form.k = Number(k.value) || 5;
  if (m) kb.form.mode = m.value;
}

async function kbSearch() {
  if (kb.searching) return;
  kbReadForm();
  const q = kb.form.q.trim();
  if (!q) { $('kb-q') && $('kb-q').focus(); return; }
  kb.searching = true;
  kbPaint();
  const qs = new URLSearchParams({ q, k: String(kb.form.k), mode: kb.form.mode });
  kb.result = await factsAPI('GET', '/api/kb/search?' + qs.toString());
  kb.searching = false;
  kbPaint('results');
}

document.addEventListener('input', ev => { if (ev.target.closest && ev.target.closest('#kb-search-form')) kbReadForm(); });
document.addEventListener('change', ev => { if (ev.target.closest && ev.target.closest('#kb-search-form')) kbReadForm(); });

/* ---------- вкладка «Сравнение» ---------- */

function kbReportHTML() {
  const r = kb.report;
  if (!r) return '<div id="kb-report"><p class="hint">загружаю…</p></div>';
  if (!r.ok) {
    if (r.code === 404) {
      return `<div id="kb-report" class="kb-report"><div class="facts-down" id="kb-report-none"><b>Отчёта сравнения ещё нет.</b>
        <div>Соберите его: <code>${esc(kbEval)}</code> — он прогонит контрольные вопросы по обоим индексам и сохранит таблицы в базу (и в examples/kb/chunking.md).</div></div></div>`;
    }
    return `<div id="kb-report"><div class="facts-error">${esc(r.error)}</div></div>`;
  }
  const d = r.data;
  const created = d.created ? new Date(d.created).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  let html = `<div id="kb-report" class="kb-report">
    <div class="kb-report-meta" id="kb-report-meta">
      <span>отчёт от <b id="kb-report-date">${esc(created)}</b></span>
      <span>эмбеддер <b>${esc(d.embedder || '—')}</b></span>
      <span>corpus_sha <code title="${esc(d.corpus_sha)}">${esc(kbShort(d.corpus_sha))}</code></span>
      <span>документов ${esc(d.docs)}, страниц ${esc(kbPages(d.pages))}</span>
      <span>бюджет топа ${esc(d.budget)} ток.</span>
    </div>`;
  const concl = kbList(d.conclusion);
  if (concl.length) {
    html += `<h4 class="kb-h">Вывод</h4><ul class="kb-conclusion" id="kb-conclusion">${concl.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  const stats = kbList(d.stats);
  html += `<h4 class="kb-h">Структура индексов</h4>
    <table class="grid kb-table" id="kb-stats-table"><tr><th>индекс</th><th>параметры</th><th class="kb-r">чанков</th><th class="kb-r">токенов</th><th class="kb-r">p50</th><th class="kb-r">p95</th>
      <th class="kb-r">на стыке разделов</th><th class="kb-r">разрезано разделов</th><th class="kb-r">перекрытие</th><th class="kb-r">оборвано посреди предложения</th><th class="kb-r">сборка, с</th><th class="kb-r">размер, КБ</th></tr>
    ${stats.map(s => `<tr class="kb-stat-row" data-index="${esc(s.index)}"><td><b>${esc(s.index)}</b></td><td>${esc(kbParams(s.params))}</td>
      <td class="kb-r">${esc(num(s.chunks))}</td><td class="kb-r">${esc(num(s.tokens))}</td><td class="kb-r">${esc(s.p50_tokens)}</td><td class="kb-r">${esc(s.p95_tokens)}</td>
      <td class="kb-r">${esc(kbPct(s.mixed_share))}</td><td class="kb-r">${esc(kbPct(s.split_sections))}</td><td class="kb-r">${esc(kbPct(s.overlap_share))}</td><td class="kb-r">${esc(kbPct(s.mid_sentence))}</td>
      <td class="kb-r">${esc(typeof s.build_seconds === 'number' ? s.build_seconds.toFixed(1) : '—')}</td><td class="kb-r">${esc(num(Math.round((s.bytes || 0) / 1024)))}</td></tr>`).join('')}</table>`;
  const ret = kbList(d.retrieval);
  // Лучшее значение колонки (среди строк того же набора и режима) — жирным.
  const best = (x, f) => {
    const peers = ret.filter(y => y.split === x.split && y.mode === x.mode).map(f);
    return peers.length > 1 && f(x) === Math.max(...peers) ? ' best' : '';
  };
  const rc = k => x => (x.recall || {})[k] || 0;
  html += `<h4 class="kb-h">Поиск по наборам вопросов</h4>
    <table class="grid kb-table" id="kb-retrieval-table"><tr><th>индекс</th><th>режим</th><th>набор</th><th class="kb-r">вопросов</th><th class="kb-r">разорвано доказательств</th>
      <th class="kb-r">recall@1</th><th class="kb-r">recall@3</th><th class="kb-r">recall@5</th><th class="kb-r">MRR</th><th class="kb-r">recall при ${esc(d.budget)} ток.</th></tr>
    ${ret.map(x => `<tr class="kb-ret-row" data-index="${esc(x.index)}" data-mode="${esc(x.mode)}" data-split="${esc(x.split)}">
      <td><b>${esc(x.index)}</b></td><td>${esc(x.mode)}${x.fallback ? ` <span class="chip warn" title="${esc(x.fallback)}">откат</span>` : ''}</td><td>${esc(x.split)}</td>
      <td class="kb-r">${esc(x.n)}</td><td class="kb-r">${esc(kbPct(x.broken_evidence))}</td>
      <td class="kb-r${best(x, rc(1))}">${esc(kbNum2(rc(1)(x)))}</td><td class="kb-r${best(x, rc(3))}">${esc(kbNum2(rc(3)(x)))}</td><td class="kb-r${best(x, rc(5))}">${esc(kbNum2(rc(5)(x)))}</td>
      <td class="kb-r${best(x, y => y.mrr || 0)}">${esc(kbNum2(x.mrr))}</td><td class="kb-r${best(x, y => y.recall_budget || 0)}">${esc(kbNum2(x.recall_budget))}</td></tr>`).join('')}</table>`;
  html += kbQuestionsHTML(ret);
  return html + '</div>';
}

// kbQuestionsHTML — вопросы test: ранг первого релевантного чанка в
// каждом индексе и режиме (— — нет в топ-20).
function kbQuestionsHTML(ret) {
  const cols = ret.filter(x => x.split === 'test');
  if (!cols.length) return '';
  const qs = [];
  for (const c of cols) for (const row of kbList(c.rows)) if (!qs.some(q => q.id === row.id)) qs.push(row);
  if (!qs.length) return '';
  return `<details class="kb-questions"><summary>Вопросы test: ранг первого релевантного чанка</summary>
    <table class="grid kb-table"><tr><th>id</th><th>вопрос</th>${cols.map(c => `<th class="kb-r">${esc(c.index)} ${esc(c.mode)}</th>`).join('')}</tr>
    ${qs.map(q => `<tr><td>${esc(q.id)}</td><td>${esc(kbCut(q.q, 110))}</td>${cols.map(c => {
      const row = kbList(c.rows).find(x => x.id === q.id);
      const rank = row ? row.rank : 0;
      return `<td class="kb-r${rank === 1 ? ' best' : ''}">${rank ? esc(rank) : '—'}</td>`;
    }).join('')}</tr>`).join('')}</table></details>`;
}

/* ---------- v22: общее для «Спросить» и «Контрольных вопросов» ---------- */

const kbModes = ['norag', 'rag'];
const kbModeTitle = { norag: 'Без базы', rag: 'С базой (RAG)' };
const kbModeHint = {
  norag: 'модель отвечает по памяти: системный промпт и вопрос',
  rag: 'тот же системный промпт и вопрос плюс найденные фрагменты базы',
};
// Значок и слово вердикта; у «не знаю» значок — сами слова.
const kbVerdicts = {
  correct: ['✓', 'верно'],
  partial: ['½', 'частично'],
  wrong: ['✗', 'неверно'],
  abstain: ['не знаю', 'не знаю'],
};
const kbSplitTitle = { test: 'test — контрольные', dev: 'dev — подбор', out: 'out — вне базы' };
// chunk_id — «doc/strategy/ord»: «manul/structure/004».
const kbChunkRe = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9_-]+\/\d{3}$/i;

function kbQuestionList() { return kb.questions && kb.questions.ok ? kbList(kb.questions.data) : []; }
function kbQuestion(id) { return id ? kbQuestionList().find(q => q.id === id) || null : null; }
function kbCost(c) {
  if (!c || typeof c.usd !== 'number') return '—';
  return (c.known ? '' : '≈') + factsUSD(c.usd);
}
function kbMs(ms) { return typeof ms === 'number' && ms > 0 ? (ms >= 1000 ? (ms / 1000).toFixed(1) + ' с' : ms + ' мс') : '—'; }
function kbSources(q) {
  return kbList(q && q.sources).map(s => s.doc_id + (s.section ? ' › ' + s.section : '')).join('; ');
}

async function kbLoadQuestions() {
  if (kb.questions && kb.questions.ok) return;
  kb.questions = await factsAPI('GET', '/api/kb/questions');
}

// kbVerdictHTML — вердикт режима; long — со словом. Пусто — ответа ещё нет.
function kbVerdictHTML(mode, v, title, long) {
  if (!v) return `<span class="kb-verdict pending" data-mode="${esc(mode)}" data-verdict="" title="ответа ещё нет">…</span>`;
  const [icon, label] = kbVerdicts[v] || ['?', v];
  const word = long && v !== 'abstain' ? ` <span class="kb-verdict-l">${esc(label)}</span>` : '';
  return `<span class="kb-verdict ${esc(v)}" data-mode="${esc(mode)}" data-verdict="${esc(v)}" title="${esc(title || label)}">${esc(icon)}${word}</span>`;
}

// kbAnswerTextHTML — ответ модели как данные: esc(), переносы строк — CSS
// (pre-wrap); ссылки [chunk_id] (и [a, b]) — кнопки к чанку. Ссылка на
// фрагмент, которого не было в выдаче, помечена: модель могла её выдумать.
function kbAnswerTextHTML(text, hits) {
  const known = new Set(kbList(hits).map(h => h.chunk_id));
  return esc(text || '').replace(/\[([^[\]\n]{3,300})\]/g, (all, inner) => {
    const ids = inner.split(/\s*[,;]\s*/);
    if (!ids.every(x => kbChunkRe.test(x))) return all;
    return ids.map(id => kbCiteHTML(id, known.has(id))).join(' ');
  });
}
function kbCiteHTML(id, found) {
  const [doc, index] = id.split('/');
  const title = found ? 'открыть фрагмент в тексте документа' : 'этого фрагмента не было в выдаче — модель могла его выдумать';
  return `<button type="button" class="kb-cite${found ? '' : ' unknown'}" data-chunk="${esc(id)}" data-doc="${esc(doc)}" data-index="${esc(index)}" data-action="kbOpenChunk" data-arg="${esc(id)}" title="${esc(title)}">[${esc(id)}]</button>`;
}

// kbRuleTitle — правило словами: что нашлось и чего нет.
function kbRuleTitle(r) {
  if (!r) return '';
  const parts = ['правило: ' + ((kbVerdicts[r.verdict] || [])[1] || r.verdict || '—')];
  if (kbList(r.hit).length) parts.push('нашлось: ' + r.hit.join(', '));
  if (kbList(r.miss).length) parts.push('нет: ' + r.miss.join(', '));
  if (kbList(r.bad).length) parts.push('лишнее: ' + r.bad.join(', '));
  if (kbList(r.numbers).length) parts.push('числа: ' + r.numbers.join(', '));
  if (r.note) parts.push(r.note);
  return parts.join('; ');
}
function kbRuleHTML(r) {
  if (!r || !r.verdict) return '';
  const bits = [];
  if (kbList(r.hit).length) bits.push(`нашлось <b>${esc(r.hit.join(', '))}</b>`);
  if (kbList(r.miss).length) bits.push(`нет <b>${esc(r.miss.join(', '))}</b>`);
  if (kbList(r.bad).length) bits.push(`лишнее <b>${esc(r.bad.join(', '))}</b>`);
  if (kbList(r.numbers).length) bits.push(`числа ${esc(r.numbers.join(', '))}`);
  if (r.note) bits.push(esc(r.note));
  return `<div class="kb-rule">правило: ${bits.join(' · ') || esc((kbVerdicts[r.verdict] || [])[1] || r.verdict)}</div>`;
}

// kbExpectHTML — ожидание вопроса из набора.
function kbExpectHTML(q, id) {
  if (!q) return '';
  const e = q.expect || {};
  const note = e.note || q.note || (q.answerable ? '' : 'в базе ответа нет — правильный исход «не знаю»');
  const must = kbList(e.must).map(g => kbList(g).join(' / ')).filter(Boolean);
  return `<div class="kb-expect"${id ? ` id="${esc(id)}"` : ''}>
    <div><b>${esc(q.id)}</b> <span class="chip">${esc(q.type)}</span>${q.answerable ? '' : ' <span class="chip warn">неотвечаемый</span>'} <span class="kb-expect-l">Ожидание:</span> ${esc(note || '—')}</div>
    ${must.length ? `<div class="hint">правило ищет: ${must.map(x => `<code>${esc(x)}</code>`).join(' · ')}</div>` : ''}
    ${kbSources(q) ? `<div class="hint">источники: ${esc(kbSources(q))}</div>` : ''}
  </div>`;
}

/* ---------- вкладка «Спросить» ---------- */

function kbAskHTML() {
  const f = kb.askForm;
  const qs = kbQuestionList();
  const groups = ['test', 'dev', 'out'].map(s => [s, qs.filter(q => q.split === s)]).filter(([, l]) => l.length);
  return `<div id="kb-ask" class="kb-ask">
    <form id="kb-ask-form" class="kb-form kb-ask-form" data-submit="kbAsk" autocomplete="off">
      <select id="kb-ask-pick" data-change="kbAskPick" title="вопрос из набора: подставит текст, ответы оценит правило">
        <option value="">свой вопрос</option>
        ${groups.map(([s, l]) => `<optgroup label="${esc(kbSplitTitle[s] || s)}">${l.map(q => `<option value="${esc(q.id)}"${q.id === f.qid ? ' selected' : ''}>${esc(q.id + ' · ' + kbCut(q.q, 64))}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <input type="text" id="kb-ask-q" value="${esc(f.q)}" placeholder="сколько видов малых панд признаёт MDD v2.5" maxlength="500">
      <button type="submit" class="solid" id="kb-ask-go"${kb.asking ? ' disabled' : ''}>${kb.asking ? '<span class="thinking">думает</span>' : 'Спросить'}</button>
    </form>
    ${kbAskContextHTML()}
    ${kb.questions && !kb.questions.ok ? `<div class="hint" id="kb-ask-noset">набора вопросов нет: ${esc(kb.questions.error)}${kb.questions.data && kb.questions.data.hint ? ' — ' + esc(kb.questions.data.hint) : ''}</div>` : ''}
    <div class="hint">Оба режима — один агент без инструментов и один системный промпт; rag получает ещё найденные фрагменты базы. Ссылка [chunk_id] в ответе — к чанку в тексте документа.</div>
    ${kbAskOutHTML()}
  </div>`;
}

// kbAskContextHTML — у вопроса-продолжения: что человек спросил перед ним.
function kbAskContextHTML() {
  const q = kbQuestion(kb.askForm.qid);
  const ctx = kbList(q && q.context);
  if (!ctx.length) return '<div id="kb-ask-context" hidden></div>';
  return `<div id="kb-ask-context" class="kb-ask-ctx">Вопрос-продолжение. Перед ним человек спросил: ${ctx.map(c => `<q>${esc(c)}</q>`).join(' → ')} — эти реплики уходят модели историей, а в поиск — вместе с вопросом.</div>`;
}

function kbAskOutHTML() {
  if (kb.asking) {
    return `<div id="kb-ask-out" class="kb-ask-out"><div class="kb-thinking"><span class="thinking">модель отвечает в двух режимах — без базы и с найденными фрагментами</span></div></div>`;
  }
  const r = kb.ask;
  if (!r) {
    return `<div id="kb-ask-out" class="kb-ask-out kb-results-empty hint">Выберите вопрос из набора — например, T03 о малых пандах в MDD v2.5 — или задайте свой. Платно: два запроса к модели.</div>`;
  }
  const d = r.data || {};
  if (!r.ok && r.code === 503) {
    return `<div id="kb-ask-out" class="kb-ask-out"><div class="facts-down kb-off" id="kb-ask-off"><b>Спросить нельзя.</b>
      <div class="kb-why">${esc(d.why || r.error)}</div>${d.hint ? `<div class="facts-hint">${esc(d.hint)}</div>` : ''}</div></div>`;
  }
  const answers = kbList(d.answers);
  if (!r.ok && !answers.length) {
    return `<div id="kb-ask-out" class="kb-ask-out"><div class="facts-error" id="kb-ask-error">${esc(r.error)}</div></div>`;
  }
  const runs = kbList(d.runs);
  const errs = String(d.error || '').split('; ').filter(Boolean);
  const errFor = m => (errs.find(e => e.startsWith(m + ': ')) || '').slice(m.length + 2);
  const q = kbQuestion(r.qid);
  return `<div id="kb-ask-out" class="kb-ask-out" data-q="${esc(d.q)}" data-qid="${esc(r.qid || '')}">
    ${kbExpectHTML(q, 'kb-ask-expect')}
    ${d.note ? `<div class="hint kb-ask-note" id="kb-ask-note">${esc(d.note)}</div>` : ''}
    <div class="kb-answers" id="kb-answers" style="--kb-cols:${Math.max(1, Math.min(answers.length, 2))}">${answers.map(a =>
      kbAnswerHTML(a, runs.find(x => x.answer && x.answer.mode === a.mode), q, errFor(a.mode))).join('')}</div>
    ${kbPromptHTML(answers)}
  </div>`;
}

// kbAnswerHTML — колонка режима: ответ, вердикт правила, цена; у rag —
// найденные фрагменты.
function kbAnswerHTML(a, run, q, err) {
  const u = a.usage || {};
  const meta = err ? '' : `<span class="kb-answer-meta" title="цена · токены вопроса → ответа · время">${esc(kbCost(a.cost))} · ${esc(num(u.prompt))} → ${esc(num(u.completion))} ток. · ${esc(kbMs(a.ms))}</span>`;
  return `<section class="kb-answer" data-mode="${esc(a.mode)}">
    <div class="kb-answer-head"><b>${esc(kbModeTitle[a.mode] || a.mode)}</b><code>${esc(a.mode)}</code>
      ${run ? kbVerdictHTML(a.mode, run.final, kbRuleTitle(run.rule), true) : ''}${meta}</div>
    <div class="kb-answer-sub hint">${esc(kbModeHint[a.mode] || '')}</div>
    ${err ? `<div class="facts-error kb-answer-error">${esc(err)}</div>` : `<div class="kb-answer-text">${kbAnswerTextHTML(a.text, a.hits)}</div>`}
    ${run ? kbRuleHTML(run.rule) : ''}
    ${a.mode === 'rag' && !err ? kbSourcesHTML(a, run, q) : ''}
  </section>`;
}

// kbSourcesHTML — выдача поиска под ответом rag: ранг, балл, статья ›
// раздел, режим поиска (dense или BM25 с причиной отката); фрагменты, на
// которые ответ сослался, и фрагменты из источников вопроса помечены.
function kbSourcesHTML(a, run, q) {
  const hits = kbList(a.hits);
  const s = a.search || {};
  const want = new Set(kbList(q && q.sources).map(x => x.doc_id));
  let recall = '';
  if (run && q && kbList(q.evidence).length) {
    recall = run.recall ? '<span class="chip ok kb-recall" data-recall="1">доказательство в выдаче ✓</span>'
      : '<span class="chip bad kb-recall" data-recall="0">доказательства в выдаче нет ✗</span>';
  }
  return `<div class="kb-srcs">
    <div class="kb-srcs-head"><b>Найденные фрагменты</b>${s.index ? ` <code>${esc(s.index)}</code>` : ''} ${kbModeLine(s)}${recall}</div>
    ${hits.length ? hits.map(h => {
      const cited = (a.text || '').includes(h.chunk_id);
      return `<div class="kb-src${cited ? ' cited' : ''}${want.has(h.doc_id) ? ' want' : ''}" data-chunk="${esc(h.chunk_id)}" data-doc="${esc(h.doc_id)}" data-index="${esc(h.strategy || s.index || '')}" data-action="kbOpenChunk" data-arg="${esc(h.chunk_id)}" title="открыть чанк в тексте документа">
        <div class="kb-hit-head"><span class="kb-rank">${esc(h.rank)}</span><span class="kb-score">${esc(typeof h.score === 'number' ? h.score.toFixed(3) : '')}</span>
          <span class="kb-hit-where"><b>${esc(h.title)}</b> › ${esc(kbPath(h))}</span>${cited ? '<span class="chip ok kb-cited">в ответе</span>' : ''}</div>
        <div class="kb-hit-text">${esc(kbCut(h.text, 200))}</div>
        <div class="kb-hit-foot"><code>${esc(h.chunk_id)}</code> · ${esc(h.tokens)} ток.</div>
      </div>`;
    }).join('') : '<p class="hint">Поиск ничего не нашёл — модель получила строку «в базе знаний ничего не найдено».</p>'}
  </div>`;
}

// kbPromptHTML — что ушло модели: видно, что режимы отличаются только
// контекстом.
function kbPromptHTML(answers) {
  const xs = answers.filter(a => a.system || a.user);
  if (!xs.length) return '';
  const same = xs.length > 1 && xs.every(a => a.system === xs[0].system);
  const head = same ? 'системный промпт одинаковый — режимы отличаются только контекстом в сообщении пользователя' : 'System и User по режимам';
  return `<details class="kb-prompt" id="kb-ask-prompt"><summary>Что ушло модели — ${esc(head)}</summary>
    <div class="kb-prompt-cols">${xs.map(a => `<div class="kb-prompt-col" data-mode="${esc(a.mode)}">
      <b>${esc(kbModeTitle[a.mode] || a.mode)}</b>
      <div class="kb-prompt-l">System · ${esc(num(Array.from(a.system || '').length))} симв.${same ? ' · <span class="chip ok">одинаковый</span>' : ''}</div>
      <pre class="kb-pre">${esc(a.system)}</pre>
      <div class="kb-prompt-l">User · ${esc(num(Array.from(a.user || '').length))} симв.</div>
      <pre class="kb-pre">${esc(a.user)}</pre></div>`).join('')}</div>
  </details>`;
}

function kbAskReadForm() {
  const q = $('kb-ask-q');
  if (!q) return;
  kb.askForm.q = q.value;
  // Текст правили — это уже не вопрос набора: правило его не оценит.
  const x = kbQuestion(kb.askForm.qid);
  if (x && x.q !== q.value.trim()) {
    kb.askForm.qid = '';
    if ($('kb-ask-pick')) $('kb-ask-pick').value = '';
    if ($('kb-ask-context')) $('kb-ask-context').outerHTML = kbAskContextHTML();
  }
}

async function kbAsk() {
  if (kb.asking) return;
  kbAskReadForm();
  const text = kb.askForm.q.trim();
  if (!text) { $('kb-ask-q') && $('kb-ask-q').focus(); return; }
  const q = kbQuestion(kb.askForm.qid);
  const body = { q: text };
  if (q) body.question_id = q.id;
  kb.asking = true;
  kbPaint('ask');
  const r = await factsAPI('POST', '/api/kb/ask', body);
  r.qid = q ? q.id : '';
  kb.ask = r;
  kb.asking = false;
  kbPaint('ask');
  if (!$('kb-ask-out')) toast(r.ok ? 'Ответы готовы — окно «База знаний», вкладка «Спросить»' : 'Спросить не вышло: ' + r.error, !r.ok);
}

document.addEventListener('input', ev => { if (ev.target.closest && ev.target.closest('#kb-ask-form')) kbAskReadForm(); });

/* ---------- вкладка «Контрольные вопросы» ---------- */

function kbQaRunning() { return !!(kb.eval && kb.eval.state === 'running'); }

// kbLoadEvals — список прогонов; open — открыть последний, если ни один не
// открыт (идёт — опрашивать).
async function kbLoadEvals(open) {
  kb.evals = await factsAPI('GET', '/api/kb/evals');
  if (!open || kb.eval || !kb.evals.ok) return;
  const last = kbList(kb.evals.data)[0];
  if (!last) return;
  const r = await factsAPI('GET', '/api/kb/evals/' + encodeURIComponent(last.id));
  if (!r.ok || kb.eval) return;
  kb.eval = r.data;
  if (kbQaRunning()) kb.timer = setTimeout(kbQaPoll, kb.pollMs);
}

function kbQaHTML() {
  const f = kb.qaForm;
  return `<div id="kb-qa" class="kb-qa">
    <form id="kb-qa-form" class="kb-form kb-qa-form" data-submit="kbQaRun" autocomplete="off">
      <label class="lbl" for="kb-qa-repeats">повторы</label>
      <select id="kb-qa-repeats">${[1, 2, 3].map(n => `<option value="${n}"${n === f.repeats ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <label class="kb-check" title="второй голос: судья-модель видит вопрос, ожидание и один ответ без пометки режима"><input type="checkbox" id="kb-qa-judge"${f.judge ? ' checked' : ''}> судья-модель</label>
      <button type="submit" class="solid" id="kb-qa-run"${kbQaRunning() || kb.starting ? ' disabled' : ''}>Прогнать набор test</button>
      <button type="button" id="kb-qa-stop" data-action="kbQaStop"${kbQaRunning() && !kb.stopping ? '' : ' hidden'}>Остановить</button>
      <span class="hint">Платно: 10 вопросов × 2 режима × повторы; судья — ещё запрос на каждый ответ.</span>
    </form>
    ${kbQaLiveHTML()}
    ${kbQaRunsHTML()}
  </div>`;
}

// kbQaQuestions — вопросы таблицы: наборы прогона (по умолчанию test);
// набора нет — вопросы из строк прогона.
function kbQaQuestions() {
  const v = kb.eval;
  const splits = v && kbList(v.request && v.request.splits).length ? v.request.splits : ['test'];
  const qs = kbQuestionList().filter(q => splits.includes(q.split));
  if (qs.length) return qs;
  return kbList(v && v.rows).map(r => r.question).filter(Boolean);
}

function kbQaErrorHTML() {
  const e = kb.evalError;
  if (!e) return '';
  if (e.code === 503) {
    return `<div class="facts-down kb-off" id="kb-qa-off"><b>Прогон запустить нельзя.</b><div class="kb-why">${esc(e.why || e.text)}</div>${e.hint ? `<div class="facts-hint">${esc(e.hint)}</div>` : ''}</div>`;
  }
  if (e.code === 409 && e.id) {
    return `<div class="facts-error" id="kb-qa-error" data-code="409">${esc(e.text)} <button type="button" class="small" data-action="kbQaOpen" data-arg="${esc(e.id)}">открыть ${esc(e.id)}</button></div>`;
  }
  return `<div class="facts-error" id="kb-qa-error" data-code="${esc(e.code)}">${esc(e.text)}${e.hint ? ' — ' + esc(e.hint) : ''}</div>`;
}

function kbQaLiveHTML() {
  const v = kb.eval;
  let html = `<div id="kb-qa-live" class="kb-qa-live">${kbQaErrorHTML()}`;
  if (kb.questions && !kb.questions.ok) {
    html += `<div class="facts-error" id="kb-qa-noset">набора вопросов нет: ${esc(kb.questions.error)}${kb.questions.data && kb.questions.data.hint ? ' — ' + esc(kb.questions.data.hint) : ''}</div>`;
  }
  if (v) {
    const pct = v.total ? Math.round(100 * (v.done || 0) / v.total) : 0;
    const req = v.request || {};
    const state = v.state === 'running' ? '<span class="thinking">идёт</span>'
      : v.state === 'done' ? '<span class="chip ok">готово</span>'
      : v.state === 'cancelled' ? '<span class="chip">остановлен</span>' : '<span class="chip bad">сбой</span>';
    html += `<div class="kb-qa-status" id="kb-qa-status" data-run="${esc(v.id)}" data-state="${esc(v.state)}">
      <b>Прогон ${esc(v.id)}</b> ${state}
      <span id="kb-qa-count">${esc(v.done || 0)} из ${esc(v.total || 0)} ответов</span>
      <span class="hint">повторов ${esc(req.repeats || 1)} · ${req.judge ? 'правило и судья' : 'только правило'} · начат ${esc(kbTime(v.started))}</span>
      <div class="kb-progress"><span style="width:${pct}%"></span></div>
      ${v.error ? `<div class="facts-error">${esc(v.error)}</div>` : ''}
    </div>`;
  }
  const qs = kbQaQuestions();
  const rows = kbList(v && v.rows);
  const modes = v && kbList(v.request && v.request.modes).length ? v.request.modes : kbModes;
  if (qs.length) {
    html += `<table class="grid kb-table kb-qa-table" id="kb-qa-table"><tr><th>id</th><th>тип</th><th>вопрос</th><th>ожидание</th><th>источники</th>
      ${kbModes.map(m => `<th class="kb-qa-v" data-mode="${esc(m)}">${esc(kbModeTitle[m])}</th>`).join('')}<th class="kb-qa-v" title="нашёлся ли в выдаче rag фрагмент с доказательством">источник найден</th></tr>
      ${qs.map(q => kbQaRowHTML(q, rows.find(r => r.question && r.question.id === q.id), modes)).join('')}</table>`;
  }
  if (v && v.report) html += kbQaSummaryHTML(v.report, v);
  return html + '</div>';
}

function kbQaRowHTML(q, row, modes) {
  const open = !!kb.qaOpen[q.id];
  const running = kbQaRunning();
  const e = q.expect || {};
  const exp = e.note || (q.answerable ? '' : 'в базе нет — ждём «не знаю»');
  const cell = m => {
    if (!modes.includes(m)) return '<span class="hint">—</span>';
    const runs = kbList(row && row.runs && row.runs[m]);
    if (!runs.length) return running || row ? kbVerdictHTML(m, '') : '';
    const v = (row.majority || {})[m] || runs[runs.length - 1].final;
    const flips = (row.flips || {})[m] || 0;
    const title = runs.map(r => 'повтор ' + r.repeat + ': ' + ((kbVerdicts[r.final] || [])[1] || r.final || 'ошибка')).join('; ') + (flips ? '; флипов ' + flips : '');
    const icon = x => (x === 'abstain' ? '?' : (kbVerdicts[x] || ['!'])[0]);
    const reps = runs.length > 1 ? `<span class="kb-reps" title="по повторам">${esc(runs.map(r => icon(r.final)).join(''))}</span>` : '';
    return kbVerdictHTML(m, v, title) + reps;
  };
  let found = '';
  const ragRuns = kbList(row && row.runs && row.runs.rag);
  if (!kbList(q.evidence).length) found = '<span class="hint" title="у вопроса нет доказательства в базе">—</span>';
  else if (ragRuns.length) {
    found = ragRuns.some(r => r.recall) ? '<span class="kb-found yes" data-found="1" title="фрагмент с доказательством в выдаче">✓</span>'
      : '<span class="kb-found no" data-found="0" title="доказательства в выдаче нет">✗</span>';
  } else if (running) found = '<span class="kb-verdict pending">…</span>';
  let html = `<tr class="kb-qa-row${open ? ' open' : ''}${row ? ' has' : ''}" data-id="${esc(q.id)}" data-action="kbQaToggle" data-arg="${esc(q.id)}" title="ответы обоих режимов и причины оценок">
    <td><b>${esc(q.id)}</b></td><td><span class="chip">${esc(q.type)}</span></td>
    <td class="kb-qa-q">${esc(q.q)}${kbList(q.context).length ? `<div class="hint">после: ${q.context.map(c => `«${esc(c)}»`).join(' → ')}</div>` : ''}</td>
    <td class="kb-qa-exp">${esc(kbCut(exp, 110))}</td><td class="kb-qa-src hint">${esc(kbSources(q))}</td>
    ${kbModes.map(m => `<td class="kb-qa-v" data-mode="${esc(m)}">${cell(m)}</td>`).join('')}<td class="kb-qa-v">${found}</td></tr>`;
  if (open) html += `<tr class="kb-qa-detail" data-id="${esc(q.id)}"><td colspan="${5 + kbModes.length + 1}">${kbQaDetailHTML(q, row, modes)}</td></tr>`;
  return html;
}

// kbQaDetailHTML — раскрытая строка: ответы режимов по повторам, оценки
// правила и судьи с причиной.
function kbQaDetailHTML(q, row, modes) {
  if (!row) return `${kbExpectHTML(q)}<p class="hint">${kbQaRunning() ? 'Ответов на этот вопрос ещё нет — прогон идёт.' : 'Этот вопрос ещё не прогонялся.'}</p>`;
  return `${kbExpectHTML(q)}<div class="kb-answers" style="--kb-cols:${Math.max(1, modes.length)}">${modes.map(m => {
    const runs = kbList(row.runs && row.runs[m]);
    return `<section class="kb-answer" data-mode="${esc(m)}">
      <div class="kb-answer-head"><b>${esc(kbModeTitle[m] || m)}</b><code>${esc(m)}</code></div>
      ${runs.length ? runs.map(r => {
        const a = r.answer || {};
        const j = r.judge;
        return `<div class="kb-run" data-repeat="${esc(r.repeat)}">
          <div class="kb-run-head">${runs.length > 1 ? `<span class="hint">повтор ${esc(r.repeat)}</span>` : ''}
            итог ${kbVerdictHTML(m, r.final, '', true)}
            <span class="hint">правило</span> ${kbVerdictHTML(m, r.rule && r.rule.verdict, kbRuleTitle(r.rule))}
            ${j ? `<span class="hint">судья</span> ${kbVerdictHTML(m, j.verdict, j.reason)}` : ''}
            <span class="kb-answer-meta">${esc(kbCost(a.cost))} · ${esc(kbMs(a.ms))}</span></div>
          ${r.error ? `<div class="facts-error">${esc(r.error)}</div>` : `<div class="kb-answer-text">${kbAnswerTextHTML(a.text, a.hits)}</div>`}
          ${j && j.reason ? `<div class="kb-judge"><b>судья:</b> ${esc(j.reason)}</div>` : ''}
          ${kbRuleHTML(r.rule)}
        </div>`;
      }).join('') : '<p class="hint">ответа нет</p>'}
    </section>`;
  }).join('')}</div>`;
}

const kbQaMetrics = [
  ['questions', 'вопросов', s => num(s.questions)],
  ['correct', 'верно', s => num(s.correct), 'max'],
  ['partial', 'частично', s => num(s.partial)],
  ['wrong', 'неверно', s => num(s.wrong), 'min'],
  ['abstain', '«не знаю»', s => num(s.abstain)],
  ['confident_wrong', 'уверенные ошибки на отвечаемых', s => num(s.confident_wrong), 'min'],
  ['right_abstain', '«не знаю» там, где ответа нет', s => num(s.right_abstain), 'max'],
  ['answered_unanswerable', 'ответ по существу там, где ответа нет', s => num(s.answered_unanswerable), 'min'],
  ['discriminative_correct', 'верно на дискриминативных', s => `${num(s.discriminative_correct)} из ${num(s.discriminative)}`, 'max'],
  ['recall', 'recall доказательств', s => (s.mode === 'norag' ? '—' : kbNum2(s.recall))],
  ['agreement', 'согласие правила и судьи', s => kbPct(s.agreement)],
  ['flip_rate', 'флипы между повторами', s => kbPct(s.flip_rate)],
  ['tokens', 'токенов', s => num((s.usage || {}).total)],
  ['cost', 'цена', s => kbCost(s.cost)],
  ['avg_ms', 'среднее время ответа', s => kbMs(s.avg_ms)],
];

function kbQaSummaryHTML(rep, v) {
  const stats = kbList(rep.stats);
  const req = (v && v.request) || {};
  const cards = stats.map(s => `<div class="kb-qa-card" data-mode="${esc(s.mode)}">
    <span>${esc(kbModeTitle[s.mode] || s.mode)}</span>
    <b>${esc(s.correct)}<small> из ${esc(s.questions)}</small></b>
    <span class="hint">частично ${esc(s.partial)} · «не знаю» ${esc(s.abstain)} · уверенных ошибок ${esc(s.confident_wrong)}</span></div>`).join('');
  const val = (s, k) => { const x = k === 'tokens' ? (s.usage || {}).total : k === 'cost' ? (s.cost || {}).usd : s[k]; return typeof x === 'number' ? x : null; };
  const best = (k, dir, s) => {
    if (!dir || stats.length < 2) return '';
    const xs = stats.map(y => val(y, k)).filter(x => x !== null);
    const x = val(s, k);
    if (x === null || xs.every(y => y === x)) return '';
    return x === (dir === 'max' ? Math.max(...xs) : Math.min(...xs)) ? ' best' : '';
  };
  const metrics = kbQaMetrics.filter(([k]) => (k !== 'agreement' || req.judge) && (k !== 'flip_rate' || (rep.repeats || req.repeats) > 1));
  const created = rep.created ? kbTime(rep.created) : '';
  return `<div id="kb-qa-summary" class="kb-qa-summary">
    <h4 class="kb-h">Итог</h4>
    <div class="kb-report-meta">${created ? `<span>от <b>${esc(created)}</b></span>` : ''}${rep.model ? `<span>модель <b>${esc(rep.model)}</b></span>` : ''}
      ${rep.index ? `<span>индекс <b>${esc(rep.index)}</b>, k ${esc(rep.k)}</span>` : ''}${rep.embedder ? `<span>эмбеддер <b>${esc(rep.embedder)}</b></span>` : ''}
      <span>повторов ${esc(rep.repeats || req.repeats || 1)}</span>${req.judge ? `<span>судья ${esc(kbCost(rep.judge_cost))}</span>` : ''}</div>
    <div class="kb-qa-cards">${cards}</div>
    <table class="grid kb-table kb-qa-stats" id="kb-qa-stats"><tr><th></th>${stats.map(s => `<th class="kb-r" data-mode="${esc(s.mode)}">${esc(kbModeTitle[s.mode] || s.mode)}</th>`).join('')}</tr>
      ${metrics.map(([k, label, f, dir]) => `<tr data-metric="${esc(k)}"><td>${esc(label)}</td>${stats.map(s => `<td class="kb-r${best(k, dir, s)}" data-mode="${esc(s.mode)}">${esc(f(s))}</td>`).join('')}</tr>`).join('')}</table>
    ${kbList(rep.conclusion).length ? `<h4 class="kb-h">Вывод</h4><ul class="kb-conclusion" id="kb-qa-conclusion">${rep.conclusion.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${kbList(rep.disagreements).length ? `<details class="kb-questions"><summary>Правило и судья разошлись: ${esc(rep.disagreements.length)}</summary><ul>${rep.disagreements.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

function kbTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// kbQaRunsHTML — прошлые прогоны (новые первыми); клик открывает прогон.
function kbQaRunsHTML() {
  const r = kb.evals;
  const list = r && r.ok ? kbList(r.data) : [];
  if (!list.length) return '<div id="kb-qa-runs" hidden></div>';
  const cur = kb.eval && kb.eval.id;
  return `<div id="kb-qa-runs" class="kb-qa-runs"><h4 class="kb-h">Прогоны</h4>${list.map(x => {
    const st = kbList(x.report && x.report.stats);
    const by = m => st.find(s => s.mode === m);
    const score = st.length ? kbModes.filter(by).map(m => `${kbModeTitle[m]} ${by(m).correct}/${by(m).questions}`).join(' · ') : '';
    const cost = st.length ? kbCost(st.reduce((c, s) => ({ usd: c.usd + ((s.cost || {}).usd || 0), known: c.known && (s.cost || {}).known }), { usd: 0, known: true })) : '';
    const state = x.state === 'running' ? 'идёт' : x.state === 'done' ? 'готово' : x.state === 'cancelled' ? 'остановлен' : 'сбой';
    return `<button type="button" class="kb-qa-run${x.id === cur ? ' on' : ''}" data-run="${esc(x.id)}" data-state="${esc(x.state)}" data-action="kbQaOpen" data-arg="${esc(x.id)}">
      <b>${esc(x.id)}</b> <span>${esc(kbTime(x.started))}</span> <span class="chip${x.state === 'done' ? ' ok' : x.state === 'failed' ? ' bad' : ''}">${esc(state)}</span>
      <span class="hint">×${esc((x.request || {}).repeats || 1)}${(x.request || {}).judge ? ', судья' : ''}</span>${score ? ` <span>${esc(score)}</span>` : ''}${cost ? ` <span class="hint">${esc(cost)}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function kbQaReadForm() {
  const r = $('kb-qa-repeats'), j = $('kb-qa-judge');
  if (r) kb.qaForm.repeats = Number(r.value) || 1;
  if (j) kb.qaForm.judge = j.checked;
}
document.addEventListener('change', ev => { if (ev.target.closest && ev.target.closest('#kb-qa-form')) kbQaReadForm(); });

async function kbQaRun() {
  if (kb.starting) return;
  kbQaReadForm();
  kb.starting = true;
  kbPaint();
  const r = await factsAPI('POST', '/api/kb/evals', { repeats: kb.qaForm.repeats, judge: kb.qaForm.judge });
  kb.starting = false;
  if (r.ok) {
    kb.eval = r.data;
    kb.evalError = null;
    kb.qaOpen = {};
    kb.watching = true;
    kbPaint('qa');
    kbQaPoll();
    await kbLoadEvals(false);
    kbPaint('runs');
  } else {
    const d = r.data || {};
    kb.evalError = { code: r.code, text: r.error, id: d.id, why: d.why, hint: d.hint };
    kbPaint('qa');
  }
}

function kbQaStopPoll() {
  if (kb.timer) clearTimeout(kb.timer);
  kb.timer = null;
}

// kbQaPoll — GET прогона раз в kb.pollMs, пока он идёт. Опрос идёт и при
// закрытом окне: об итоге скажет тост. Новый вызов отменяет прежний цикл.
async function kbQaPoll() {
  kbQaStopPoll();
  const id = kb.eval && kb.eval.id;
  const seq = ++kb.seq;
  if (!id) return;
  const r = await factsAPI('GET', '/api/kb/evals/' + encodeURIComponent(id));
  if (kb.seq !== seq || !kb.eval || kb.eval.id !== id) return; // тем временем открыли другой прогон
  if (r.ok) kb.eval = r.data;
  else kb.evalError = { code: r.code, text: r.error };
  const done = !r.ok || !kbQaRunning();
  if (done) {
    await kbLoadEvals(false);
    if (kb.seq !== seq) return;
  }
  kbPaint('qa', done ? 'runs' : '');
  if (!done) {
    kb.timer = setTimeout(kbQaPoll, kb.pollMs);
    return;
  }
  if (kb.watching && !$('kb-qa') && r.ok) {
    const st = kbList(kb.eval.report && kb.eval.report.stats).find(s => s.mode === 'rag');
    const what = kb.eval.state === 'done' ? 'прогон готов' + (st ? `, с базой верно ${st.correct} из ${st.questions}` : '')
      : kb.eval.state === 'cancelled' ? 'прогон остановлен' : 'сбой — подробности в окне «База знаний»';
    toast('Контрольные вопросы: ' + what, kb.eval.state === 'failed');
  }
  kb.watching = false;
}

Object.assign(actions, {
  kbAsk() { kbAsk(); },
  kbAskPick(id) {
    kb.askForm.qid = id || '';
    const q = kbQuestion(id);
    if (q) {
      kb.askForm.q = q.q;
      if ($('kb-ask-q')) $('kb-ask-q').value = q.q;
    }
    if ($('kb-ask-context')) $('kb-ask-context').outerHTML = kbAskContextHTML();
  },
  kbQaRun() { kbQaRun(); },
  // kbQaStop — DELETE прогона: сервер отменяет его контекст и сразу
  // отвечает состоянием cancelled со строками, что успели.
  async kbQaStop() {
    const id = kb.eval && kb.eval.id;
    if (!id || !kbQaRunning() || kb.stopping) return;
    kb.stopping = true;
    kbPaint();
    const r = await factsAPI('DELETE', '/api/kb/evals/' + encodeURIComponent(id));
    kb.stopping = false;
    if (!r.ok && r.code !== 409) { toast('Остановить не вышло: ' + r.error, true); kbPaint(); return; }
    if (r.ok && kb.eval && kb.eval.id === id) kb.eval = r.data;
    kbQaPoll();
  },
  kbQaToggle(id) {
    if (!id) return;
    kb.qaOpen[id] = !kb.qaOpen[id];
    kbPaint('qa');
  },
  async kbQaOpen(id) {
    if (!id) return;
    const r = await factsAPI('GET', '/api/kb/evals/' + encodeURIComponent(id));
    if (!r.ok) { toast('Прогон не открылся: ' + r.error, true); return; }
    kbQaStopPoll();
    kb.seq++;
    kb.eval = r.data;
    kb.evalError = null;
    kb.qaOpen = {};
    kbPaint('qa', 'runs');
    if (kbQaRunning()) kb.timer = setTimeout(kbQaPoll, kb.pollMs);
  },
});

/* ---------- действия ---------- */

Object.assign(actions, {
  async kbTab(tab) {
    if (!kbTabs.some(([id]) => id === tab)) return;
    if (kb.tab === 'search') kbReadForm();
    if (kb.tab === 'ask') kbAskReadForm();
    kb.tab = tab;
    if (tab !== 'chunks') kb.focus = '';
    kbPaint('tabs', 'body');
    if (tab === 'chunks') await kbShowChunks(false);
    if (tab === 'report' && (!kb.report || !kb.report.ok)) {
      await kbLoadReport();
      if (kb.tab === 'report') kbPaint('body');
    }
    if ((tab === 'ask' || tab === 'qa') && kbBase()) {
      await kbLoadTab();
      if (kb.tab === tab) kbPaint('body');
      if (tab === 'qa' && kbQaRunning()) kbQaPoll();
    }
  },
  async kbOpenDoc(id) {
    if (!id) return;
    kb.doc = id;
    kb.focus = '';
    kb.tab = 'chunks';
    kbPaint('tabs');
    await kbShowChunks(true);
    const t = $('kb-text');
    if (t) t.scrollIntoView({ block: 'start' });
  },
  async kbOpenChunk(id, el) {
    if (!id || !el) return;
    kbReadForm();
    kbAskReadForm();
    kb.doc = el.dataset.doc || kb.doc;
    if (el.dataset.index) kb.strategy = el.dataset.index;
    kb.focus = id;
    kb.tab = 'chunks';
    kbPaint('tabs');
    await kbShowChunks(true);
  },
  async kbPickDoc(id) {
    if (!id) return;
    kb.doc = id;
    kb.focus = '';
    await kbShowChunks(true);
  },
  async kbPickStrategy(s) {
    if (!s || s === kb.strategy) return;
    kb.strategy = s;
    // Чанк из другой стратегии — не тот, к которому прокручивать.
    if (kb.focus && !kb.focus.includes('/' + s + '/')) kb.focus = '';
    const top = $('window-body') ? $('window-body').scrollTop : 0;
    await kbShowChunks(true);
    if (!kb.focus && $('window-body')) $('window-body').scrollTop = top;
  },
  kbSearch() { kbSearch(); },
});

// kbPlaceButton — «База знаний» сразу за «MCP-серверы»: кнопки разделов
// встают за «Окна ▾» по мере ответов своих REST, порядок заранее не известен.
function kbPlaceButton() {
  const b = $('kb-button'), h = $('hub-button');
  if (b && h && h.nextElementSibling !== b) h.insertAdjacentElement('afterend', b);
}

kbRenderButton();
if ($('kb-button')) new MutationObserver(kbPlaceButton).observe($('kb-button').parentElement, { childList: true });
kbLoadInfo();
