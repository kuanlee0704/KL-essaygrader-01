// ============================================================
// 國文「作文文字」區：專門處理「從外面接進來的文字」
// ------------------------------------------------------------
// 文字的來源通常有三種，各有各的毛病：
//   1. 從 Word／Google 文件／PDF／網頁貼上 → 隱形字元、多餘空白、PDF 硬斷行、半形標點
//   2. 稿紙格線辨識、整頁辨識的結果     → 還有［？］沒確認、要核對行數
//   3. 自己手打                          → 少了小題標記（一）（二）
// 這個模組把這些「接入」的環節處理好：貼上時自動清理、狀態列即時回報、
// ［？］變成可點選的待確認清單、常見問題用「一鍵修正＋可復原」處理。
// 純函式（cleanText、analyze…）和畫面（render／bind）分開，方便單獨測試。
// ============================================================

const SECTION_NUMS = '一二三四五六七八九十';
const MARK_SRC = '［？］|\\[\\?\\]|\\[？\\]|［\\?］';
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
const SECTION_ONLY = new RegExp('^[（(][' + SECTION_NUMS + '][）)]$');
const SECTION_START = new RegExp('^[（(][' + SECTION_NUMS + '][）)]');
const SENTENCE_END = /[。！？；：」』）”’…—.!?;:"')\]］]$/;
const CELLS_PER_LINE = 22; // 學測稿紙：1 行＝1 欄＝22 格

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const len = (s) => Array.from(s).length;
const isCJK = (c) => !!c && /[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(c);
const isDigit = (c) => !!c && /[0-9]/.test(c);
const isLatin = (c) => !!c && /[A-Za-z0-9]/.test(c);

// 和 app.js、後端一致：國文算字（含標點、不含空白與換行）
export const countChars = (text) => {
  const t = String(text || '').trim();
  return t ? len(t.replace(/\s/g, '')) : 0;
};

// ---------- 純函式 ----------

/**
 * 整理外面來的文字。只做「不會改變文意」的事：
 * 隱形字元、換行統一、不換行空白、Tab、多餘的行首／行尾空白、連續空行、［？］標記寫法。
 * 注意：行首的全形空白（　）不動——稿紙辨識結果用它表示段首空格，估算行數也會用到。
 * paste＝true 表示這是「貼上的片段」，第一行的行首、最後一行的行尾不處理（可能接在別的字中間）。
 */
export function cleanText(raw, { paste = false } = {}) {
  const report = [];
  let t = String(raw ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n');

  let n = 0;
  t = t.replace(INVISIBLE, () => { n++; return ''; });
  if (n) report.push(`移除 ${n} 個隱形字元`);

  let m = 0;
  t = t.replace(/\[\?\]|\[？\]|［\?］/g, () => { m++; return '［？］'; });
  if (m) report.push(`統一 ${m} 處「［？］」標記`);

  const before = t;
  const lines = t.replace(/[\u00A0\t]/g, ' ').split('\n');
  t = lines.map((l, i) => {
    if (!(paste && i === 0)) l = l.replace(/^ +/, '');
    if (!(paste && i === lines.length - 1)) l = l.replace(/[ \u3000]+$/, '');
    return l;
  }).join('\n').replace(/\n{3,}/g, '\n\n');
  if (!paste) t = t.replace(/^\n+/, '').replace(/\s+$/, '');
  if (t !== before) report.push('整理多餘的空白與空行');

  return { text: t, report };
}

/** 半形標點（, . ; : ? ! ( )）緊貼中文時改成全形；數字小數點、英文縮寫、網址不動 */
export function fullWidthPunct(text) {
  const MAP = { ',': '，', '.': '。', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）' };
  const s = Array.from(String(text ?? ''));
  let out = '';
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const to = MAP[c];
    if (!to) { out += c; continue; }
    const prev = s[i - 1];
    const next = s[i + 1];
    const touchesCJK = isCJK(prev) || isCJK(next);
    const numeric = isDigit(prev) && isDigit(next);
    const ellipsis = c === '.' && (prev === '.' || next === '.');
    if (!touchesCJK || numeric || ellipsis) { out += c; continue; }
    out += to;
    count++;
    if (',.;:?!'.includes(c) && next === ' ') i++; // 「你好, 世界」→「你好，世界」，吃掉多的空格
  }
  return { text: out, count };
}

/** 偵測 PDF／網頁複製常見的「每行寬度固定、句子被硬切斷」：多數行沒有以句末標點結尾 */
export function looksHardWrapped(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !SECTION_ONLY.test(l));
  if (lines.length < 4) return false;
  const open = lines.filter((l) => !SENTENCE_END.test(l)).length;
  return open >= 3 && open / lines.length >= 0.5;
}

/** 合併硬斷行：只把「沒有句末標點的行」接到下一行；有句末標點、空行、小題標記、段首空格都視為段落邊界 */
export function mergeHardWraps(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/[ \u3000]+$/, '');
    const trimmed = line.trim();
    if (!trimmed) { flush(); out.push(''); continue; }
    if (SECTION_ONLY.test(trimmed)) { flush(); out.push(trimmed); continue; }
    const newPara = /^(\u3000| {2,})/.test(line) || SECTION_START.test(trimmed);
    if (buf && newPara) flush();
    if (buf && isLatin(buf.slice(-1)) && isLatin(trimmed[0])) buf += ' '; // 英文單字之間補空格
    buf += buf ? trimmed : line;
    if (SENTENCE_END.test(trimmed)) flush();
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function findUnclear(text) {
  const re = new RegExp(MARK_SRC, 'g');
  const flat = String(text || '');
  const res = [];
  let m;
  while ((m = re.exec(flat))) {
    const a = Math.max(flat.lastIndexOf('\n', m.index - 1) + 1, m.index - 4);
    let b = flat.indexOf('\n', m.index + m[0].length);
    if (b < 0) b = flat.length;
    b = Math.min(b, m.index + m[0].length + 4);
    // 前後文不要沾到相鄰的［？］
    const pre = flat.slice(a, m.index).replace(/^[\s\S]*[］\]]/, '');
    const post = flat.slice(m.index + m[0].length, b).replace(/[［\[][\s\S]*$/, '');
    res.push({ start: m.index, end: m.index + m[0].length, pre, post });
  }
  return res;
}
export const countUnclear = (text) => findUnclear(text).length;

/** 估算稿紙用了幾行：每段從新的一欄開始；段首空格用實際的（沒有就當空兩格）；小題標記獨占一行時不算 */
export function estimateLines(text) {
  let paras = 0;
  let lines = 0;
  for (const raw of String(text || '').split('\n')) {
    const body = raw.replace(/[\s\u3000]/g, '');
    if (!body) continue;
    if (SECTION_ONLY.test(body)) continue;
    paras++;
    const lead = (raw.match(/^[\u3000 ]*/) || [''])[0].length;
    const indent = lead > 0 ? Math.min(lead, 4) : 2;
    lines += Math.ceil((indent + len(body)) / CELLS_PER_LINE);
  }
  return { paras, lines };
}

export function analyze(text, ocrInfo) {
  const t = String(text || '');
  const sections = [];
  t.split('\n').forEach((l) => {
    const m = l.trim().match(new RegExp('^[（(]([' + SECTION_NUMS + '])[）)]'));
    if (m && !sections.includes(m[1])) sections.push(m[1]);
  });
  const marks = findUnclear(t);
  const { paras, lines } = estimateLines(t);
  const sheets = Array.isArray(ocrInfo) ? ocrInfo : [];
  const ocrLines = sheets.reduce((a, o) => a + (Number(o.lines) || 0), 0);
  const ocrChars = sheets.reduce((a, o) => a + (Number(o.chars) || 0), 0);
  const chars = countChars(t);
  const adjusted = chars - marks.length * 2; // 每個［？］在字數裡算 3 個字，格線辨識時只占 1 格
  return {
    chars, paras, lines, sections, marks,
    half: fullWidthPunct(t).count,
    wrapped: !sheets.length && looksHardWrapped(t),
    ocrLines, ocrChars, hasOcr: sheets.length > 0,
    ocrStale: ocrChars > 0 && Math.abs(adjusted - ocrChars) > Math.max(10, ocrChars * 0.08),
  };
}

// ---------- 畫面 ----------

const undoStacks = new Map(); // essayId → 修改前的文字（讓「一鍵修正」都能復原）

export function renderZhTextBox({ essay, grading, placeholder }) {
  const d = grading ? 'disabled' : '';
  const hasOcr = (essay.ocrInfo || []).length > 0;
  const sec = ['一', '二', '三'].map((n) =>
    `<button type="button" class="ztb-btn" data-ztb="sec" data-n="${n}" ${d} title="在游標位置插入小題標記（${n}），自己會獨立成一行">（${n}）</button>`).join('');
  return `
    <div class="box-sub"><span>文字</span><small>可單獨使用，也可以和照片並用</small>${hasOcr ? '<span class="ztb-src" title="這份文字來自稿紙格線辨識">📐 格線辨識</span>' : ''}</div>
    <div class="ztb${grading ? ' is-disabled' : ''}" id="ztb">
      <div class="ztb-bar" role="toolbar" aria-label="作文文字工具">
        <button type="button" class="ztb-btn" data-ztb="clean" ${d} title="清掉隱形字元、多餘空白與重複空行（貼上時也會自動做）">✨ 整理格式</button>
        <span class="ztb-sep" aria-hidden="true"></span>
        <span class="ztb-group"><span class="ztb-label">插入小題</span>${sec}</span>
        <span class="ztb-grow"></span>
        <button type="button" class="ztb-btn" data-ztb="undo" disabled title="復原上一個整理動作">↶ 復原</button>
      </div>
      <textarea id="essayTextInput" class="box-text ztb-text" rows="8" lang="zh-Hant" spellcheck="false"
        placeholder="${esc(placeholder)}" ${d}>${esc(essay.essayText || '')}</textarea>
      <div class="ztb-notice" id="ztbNotice" role="status" hidden></div>
      <div class="ztb-status" id="ztbStatus"></div>
      <div class="ztb-list" id="ztbMarks"></div>
      <div class="ztb-list" id="ztbTips"></div>
    </div>`;
}

// 把 textarea 捲到某個字的位置（textarea 沒有內建的「捲到選取處」，用隱形鏡像量高度）
function scrollToIndex(el, idx) {
  const cs = getComputedStyle(el);
  const mirror = document.createElement('div');
  ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordBreak', 'overflowWrap', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'boxSizing'].forEach((p) => { mirror.style[p] = cs[p]; });
  mirror.style.cssText += ';position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;width:' + el.offsetWidth + 'px;';
  mirror.textContent = el.value.slice(0, idx);
  const probe = document.createElement('span');
  probe.textContent = '\u200b';
  mirror.appendChild(probe);
  document.body.appendChild(mirror);
  const top = probe.offsetTop;
  mirror.remove();
  el.scrollTop = Math.max(0, top - el.clientHeight / 2);
}

export function bindZhTextBox(essay) {
  const root = document.getElementById('ztb');
  const el = document.getElementById('essayTextInput');
  if (!root || !el) return;
  const q = (s) => root.querySelector(s);
  const stack = undoStacks.get(essay.id) || [];
  undoStacks.set(essay.id, stack);
  let noticeTimer = 0;
  let timer = 0;

  const fire = () => el.dispatchEvent(new Event('input', { bubbles: true })); // 交給 app.js 原有的自動儲存
  const syncUndo = () => { q('[data-ztb=undo]').disabled = !stack.length || el.disabled; };

  function notice(msg, withUndo = true) {
    const box = q('#ztbNotice');
    clearTimeout(noticeTimer);
    box.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button type="button" class="ztb-link" data-ztb="undo">復原</button>' : ''}`;
    box.hidden = false;
    noticeTimer = setTimeout(() => { box.hidden = true; }, 10000);
  }
  function apply(next, msg) {
    if (next === el.value) return false;
    stack.push(el.value);
    if (stack.length > 8) stack.shift();
    const top = el.scrollTop;
    el.value = next;
    fire();
    el.scrollTop = top;
    notice(msg);
    return true;
  }

  function refresh() {
    const a = analyze(el.value, essay.ocrInfo);
    syncUndo();

    // 狀態列
    const st = q('#ztbStatus');
    if (!a.chars) {
      st.innerHTML = '<span class="ztb-hint">可直接從 Word、Google 文件、PDF 或網頁貼上；隱形字元與多餘空白會自動清掉。</span>';
    } else {
      const bits = [`<span class="ztb-stat"><b>${a.chars}</b> 字</span>`];
      if (a.hasOcr) bits.push(`<span class="ztb-stat ok" title="稿紙格線辨識當下量到的實際行數，批改時用它核對行數限制"><b>${a.ocrLines}</b> 行（格線量測）</span>`);
      else bits.push(`<span class="ztb-stat" title="以 22 字一行、段首空兩格估算，僅供參考；實際以稿紙為準"><b>約 ${a.lines}</b> 行（估）</span>`);
      bits.push(`<span class="ztb-stat"><b>${a.paras}</b> 段</span>`);
      if (a.sections.length) bits.push(`<span class="ztb-stat" title="已偵測到的小題標記">小題 ${a.sections.map((n) => `（${n}）`).join('')}</span>`);
      st.innerHTML = bits.join('');
    }

    // ［？］待確認清單
    const mk = q('#ztbMarks');
    if (a.marks.length) {
      const shown = a.marks.slice(0, 12);
      mk.innerHTML = `<div class="ztb-row warn">
        <div class="ztb-row-head"><b>⚠ 有 ${a.marks.length} 處看不清楚（［？］）</b>
          <span class="ztb-nav"><button type="button" class="ztb-link" data-ztb="prev">‹ 上一處</button><button type="button" class="ztb-link" data-ztb="next">下一處 ›</button></span></div>
        <div class="ztb-chips">${shown.map((m, i) => `<button type="button" class="ztb-mark" data-ztb="mark" data-i="${i}" title="跳到這一處"><span>${esc(m.pre)}</span><mark>［？］</mark><span>${esc(m.post)}</span></button>`).join('')}${a.marks.length > shown.length ? `<small class="ztb-more">…還有 ${a.marks.length - shown.length} 處</small>` : ''}</div>
        <small>對照照片後，點一處跳過去，直接輸入正確的字就會取代標記。</small></div>`;
    } else if (a.hasOcr && a.chars) {
      mk.innerHTML = '<div class="ztb-row ok"><span>✓ 沒有待確認的字。還是建議對照照片再掃一遍，再按批改。</span></div>';
    } else mk.innerHTML = '';

    // 建議（只在有問題時出現）
    const tips = [];
    if (a.half) tips.push(`<div class="ztb-row"><span>有 <b>${a.half}</b> 處半形標點（, . ? 等）緊貼中文。中文作文的標點會被檢查，建議改成全形。</span><button type="button" class="ztb-btn sm" data-ztb="fw">改成全形</button></div>`);
    if (a.wrapped) tips.push('<div class="ztb-row"><span>看起來像是從 PDF 或網頁複製來的，句子被硬切成很多行。</span><button type="button" class="ztb-btn sm" data-ztb="merge">合併斷行</button></div>');
    if (a.ocrStale) tips.push(`<div class="ztb-row"><span>文字和辨識當時差了不少（現在約 ${a.chars} 字，辨識時 ${a.ocrChars} 字），上面的行數是辨識當下量的，核對行數限制時可能有誤差。</span></div>`);
    q('#ztbTips').innerHTML = tips.join('');
  }
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };

  function jump(i) {
    const m = findUnclear(el.value)[i];
    if (!m) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(m.start, m.end);
    scrollToIndex(el, m.start);
  }
  function step(dir) {
    const marks = findUnclear(el.value);
    if (!marks.length) return;
    const from = dir > 0 ? el.selectionEnd : el.selectionStart;
    let i;
    if (dir > 0) { i = marks.findIndex((m) => m.start >= from); if (i < 0) i = 0; }
    else { i = marks.map((m) => m.start < from).lastIndexOf(true); if (i < 0) i = marks.length - 1; }
    jump(i);
  }

  el.addEventListener('input', refreshSoon);

  // 貼上：自動清理（沒有需要清的就交給瀏覽器原本的貼上）
  el.addEventListener('paste', (e) => {
    const raw = e.clipboardData?.getData('text/plain');
    if (raw == null) return;
    const { text, report } = cleanText(raw, { paste: true });
    if (text === raw.replace(/\r\n?/g, '\n')) return;
    e.preventDefault();
    stack.push(el.value);
    if (stack.length > 8) stack.shift();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { /* 改用下面的做法 */ }
    if (!ok) { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); fire(); }
    notice('已整理貼上的內容：' + (report.join('、') || '調整格式') + '。');
    refresh();
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ztb]');
    if (!btn || btn.disabled || el.disabled) return;
    switch (btn.dataset.ztb) {
      case 'clean': {
        const r = cleanText(el.value);
        if (!apply(r.text, '已整理：' + r.report.join('、') + '。')) notice('格式已經很乾淨，沒有需要整理的地方。', false);
        break;
      }
      case 'fw': {
        const r = fullWidthPunct(el.value);
        apply(r.text, `已把 ${r.count} 處半形標點改成全形。`);
        break;
      }
      case 'merge': {
        const before = el.value.split('\n').length;
        const next = mergeHardWraps(el.value);
        apply(next, `已合併斷行（${before} 行 → ${next.split('\n').length} 行）。請快速看一遍分段對不對。`);
        break;
      }
      case 'sec': {
        // 小題標記獨占一行：游標不在行首就先換行；標記後換行，接著寫正文
        const s = el.selectionStart;
        const e2 = el.selectionEnd;
        const v = el.value;
        const atLineStart = s === 0 || v[s - 1] === '\n';
        const ins = (atLineStart ? '' : '\n') + `（${btn.dataset.n}）\n`;
        stack.push(v);
        if (stack.length > 8) stack.shift();
        el.focus();
        el.setRangeText(ins, s, e2, 'end');
        fire();
        notice(`已插入小題標記（${btn.dataset.n}）。`);
        break;
      }
      case 'undo': {
        const prev = stack.pop();
        if (prev == null) break;
        const top = el.scrollTop;
        el.value = prev;
        fire();
        el.scrollTop = top;
        q('#ztbNotice').hidden = true;
        break;
      }
      case 'mark': jump(Number(btn.dataset.i)); return;
      case 'prev': step(-1); return;
      case 'next': step(1); return;
      default: return;
    }
    refresh();
  });

  refresh();
}

/** 題目文字框用的精簡版：貼上時只清掉隱形字元與換行問題，不跳通知 */
export function attachPasteClean(el) {
  el?.addEventListener('paste', (e) => {
    const raw = e.clipboardData?.getData('text/plain');
    if (raw == null) return;
    const { text } = cleanText(raw, { paste: true });
    if (text === raw.replace(/\r\n?/g, '\n')) return;
    e.preventDefault();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { /* 改用下面的做法 */ }
    if (!ok) { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}
