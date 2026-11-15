// ============================================================
// 作文批改室 — 主程式（畫面與互動）
// ============================================================
import * as store from './store.js';
import * as api from './api.js';
import * as theme from './theme.js';
import { openGridOcr } from './ocr.js';
import { renderZhTextBox, bindZhTextBox, attachPasteClean, countUnclear } from './textbox.js';

theme.applyTheme();

const SUBJECTS = {
  zh: { name: '國文', full: '學測國寫', placeholder: '例如：這是 115 學測第二大題；我想加強結尾的深度…' },
  en: { name: '英文', full: '學測英文作文', placeholder: '例如：模考第二次；我想知道文法哪裡最需要加強…' },
};
const TABS = [
  { id: 'overview', label: '分數與評語' },
  { id: 'improve', label: '可進步之處' },
  { id: 'rewrite', label: '滿分改寫' },
  { id: 'notes', label: '筆記' },
  { id: 'original', label: '原文與題目' },
];
const QUICK_ASKS = {
  zh: ['為什麼我是這個級分？', '怎麼改才能拿到 A+？', '幫我重寫開頭段', '再給我一個不同的結尾'],
  en: ['我最需要先改哪個文法？', '怎麼拿到特優？', '幫我改寫第一段', '教我 3 個可以用的進階句型'],
};

// ---------- 小圖示 ----------
const I = {
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 4l14 8-14 8z"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
  doc: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  image: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  spark: '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 20h7M20 4v7M30 10l-5 5"/></svg>',
};

const state = {
  view: 'subject', // subject | settings
  subject: 'zh',
  currentId: null,
  essays: [],
  tab: 'overview',
  improveFilter: '全部',
  rewriteView: 'rewrite',
  uploadOpen: false,
  chatOpenMobile: false,
  chatBusy: new Set(), // 正在等 AI 回覆的作文 id
  watching: new Set(), // 正在輪詢批改進度的作文 id
  me: null, // 目前登入者與今日用量
  ready: false,
  loginOpen: false,
  listLoaded: {},
  search: '',
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

// ---------- 小工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function md(text) {
  // 先把 < > & 全部跳脫，再只轉換粗體、斜體、標題、條列、引用、程式碼，所以不可能夾帶 HTML
  const lines = esc(text).split('\n');
  let html = '';
  let list = null;
  let code = false;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>');
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { closeList(); html += code ? '</pre>' : '<pre>'; code = !code; continue; }
    if (code) { html += line + '\n'; continue; }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    closeList();
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const q = /^&gt;\s?(.*)$/.exec(line);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (q) html += `<blockquote>${inline(q[1])}</blockquote>`;
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) html += '<hr>';
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeList();
  if (code) html += '</pre>';
  return html;
}
function fmtDate(ts, short = false) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return short ? `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2800);
  setTimeout(() => el.remove(), 3200);
}

// ---------- 彈出視窗 ----------
function modal({ title, body, actions = [], wide = false, onMount }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        ${title ? `<h3 class="modal-title">${title}</h3>` : ''}
        <div class="modal-body">${body}</div>
        ${actions.length ? `<div class="modal-actions">${actions.map((a, i) => `<button class="btn ${a.kind || 'outline'}" data-i="${i}">${a.label}</button>`).join('')}</div>` : ''}
      </div>`;
    const close = (val) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', async (e) => {
      if (e.target === wrap) return close(null);
      const btn = e.target.closest('[data-i]');
      if (!btn) return;
      const a = actions[Number(btn.dataset.i)];
      if (a.onClick) {
        const r = await a.onClick(wrap, btn);
        if (r === false) return;
        close(r === undefined ? a.value : r);
      } else close(a.value);
    });
    $('#modalRoot').appendChild(wrap);
    onMount && onMount(wrap, close);
    const firstInput = wrap.querySelector('input:not([type=radio]):not([type=checkbox]), textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 30);
  });
}

// ---------- 路由：#/zh 、 #/en/作文ID 、 #/settings ----------
async function route() {
  const hash = location.hash;
  if (!state.ready) return;
  if (hash === '#how') { // 首頁的「怎麼使用」：只捲動，不換頁
    history.replaceState(null, '', `#/${state.subject}${state.currentId ? '/' + state.currentId : ''}`);
    document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  store.flushAll().catch(() => {});
  const prevId = state.currentId;
  if (hash === '#/settings') {
    state.view = 'settings';
    state.currentId = null;
  } else {
    const [, subject, id] = hash.match(/^#\/(zh|en)(?:\/(.+))?$/) || [];
    state.view = 'subject';
    if (subject && subject !== state.subject) state.search = '';
    state.subject = subject || 'zh';
    state.currentId = id || null;
  }
  if (state.currentId !== prevId) {
    Object.assign(state, { tab: 'overview', improveFilter: '全部', rewriteView: 'rewrite', uploadOpen: false, chatOpenMobile: false });
    if (state.currentId) store.markStale(state.currentId, 15000); // 切回來時，超過 15 秒的快取重新抓
  }
  document.body.dataset.subject = state.subject;
  document.querySelectorAll('[data-subject-tab]').forEach((a) =>
    a.classList.toggle('active', state.view === 'subject' && a.dataset.subjectTab === state.subject));
  document.querySelector('[data-nav=settings]')?.classList.toggle('active', state.view === 'settings');
  document.body.classList.remove('sidebar-open');
  window.scrollTo(0, 0);
  state.essays = store.cachedList(state.subject) || [];
  renderSidebar();
  refreshList(); // 背景更新列表，不擋住主畫面
  await renderMain();
}

async function refreshList() {
  const subject = state.subject;
  try {
    const list = await store.listEssays(subject);
    state.listLoaded[subject] = true;
    if (state.subject === subject) { state.essays = list; renderSidebar(); }
  } catch (err) {
    handleApiError(err);
  }
}

// 本機先更新列表上的小資訊（不用等網路）
function updateMeta(id, patch) {
  const m = state.essays.find((x) => x.id === id);
  if (m) { Object.assign(m, patch); renderSidebar(); }
}

// ---------- 側邊欄 ----------
function statusBadge(e) {
  if (e.status === 'grading') return '<span class="badge grading">批改中</span>';
  if (e.status === 'error' && !e.gradedAt) return '<span class="badge error">失敗</span>';
  if (e.gradedAt) return `<span class="badge score">${fmtNum(e.scoreTotal)}<small>/${fmtNum(e.scoreMax)}</small></span>`;
  return '<span class="badge draft">草稿</span>';
}

function renderSidebar() {
  $('#sidebarTitle').textContent = `${SUBJECTS[state.subject].name}作文`;
  $('#sidebarCount').textContent = state.essays.length;
  $('#searchInput').value = state.search;
  const q = state.search.trim().toLowerCase();
  const list = state.essays.filter((e) => !q || e.title.toLowerCase().includes(q));
  const box = $('#essayList');
  if (!state.essays.length && !state.listLoaded[state.subject]) {
    box.innerHTML = '<div class="list-empty">讀取中…</div>';
    return;
  }
  if (!state.essays.length) {
    box.innerHTML = `<div class="list-empty">還沒有${SUBJECTS[state.subject].name}作文<br><button class="link" data-action="new-essay">＋ 新增第一篇</button></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="list-empty">找不到符合的作文</div>';
    return;
  }
  box.innerHTML = list.map((e) => `
    <a class="essay-item ${e.id === state.currentId ? 'active' : ''}" href="#/${e.subject}/${e.id}">
      <span class="essay-item-icon">${I.doc}</span>
      <span class="essay-item-text">
        <span class="essay-item-title">${esc(e.title)}</span>
        <span class="essay-item-date">${fmtDate(e.updatedAt, true)}${e.chatCount ? ` · ${e.chatCount} 則對話` : ''}</span>
      </span>
      ${statusBadge(e)}
    </a>`).join('');
}

// ---------- 主畫面 ----------
const isAuthError = (err) => err?.code === 'BAD_CODE' || err?.code === 'NO_CODE';

function isTyping() {
  const a = document.activeElement;
  return !!a && /^(TEXTAREA|INPUT)$/.test(a.tagName);
}

// 照片只存編號；真正的圖片先看本機快取，沒有才向後端要
function hydrateImages(root = document) {
  const essayId = state.currentId;
  root.querySelectorAll('img[data-img-id]:not([src])').forEach((img) => {
    store.imgSrc(essayId, img.dataset.imgId)
      .then((src) => { img.src = src; })
      .catch(() => { img.classList.add('broken'); img.alt = '照片載入失敗'; });
  });
}

function showLoadError(err) {
  main.innerHTML = `<div class="card error-card" style="margin:24px"><div><b>讀取失敗</b><p>${esc(err.message)}</p></div><button class="btn primary sm" data-action="reload">重試</button></div>`;
}

async function renderMain() {
  if (state.view === 'settings') return renderSettings();
  if (!state.currentId) return renderHome();
  const id = state.currentId;
  let essay = store.peekEssay(id);
  if (!essay) {
    main.innerHTML = '<div class="loading-block"><div class="spinner"></div><p>讀取中…</p></div>';
    try {
      essay = await store.getEssay(id);
    } catch (err) {
      if (state.currentId !== id) return;
      if (isAuthError(err)) return handleApiError(err);
      return showLoadError(err);
    }
  }
  if (state.currentId !== id) return;
  if (!essay || essay.subject !== state.subject) {
    location.hash = `#/${state.subject}`;
    return;
  }
  renderEssay(essay);
  if (essay.status === 'grading' || essay.phase === 'rewrite') watchEssay(id);
}

// ---------- 首頁 ----------
function renderHome() {
  const zh = state.subject === 'zh';
  const graded = state.essays.filter((e) => e.gradedAt).sort((a, b) => (a.gradedAt || 0) - (b.gradedAt || 0));
  const sample = graded.length === 0;
  const pct = (e) => Math.round((e.scoreTotal / (e.scoreMax || 1)) * 100);
  const trend = sample ? [58, 66, 62, 74, 70, 84] : graded.slice(-6).map(pct);
  const avg = sample ? 72 : Math.round(graded.reduce((a, e) => a + pct(e), 0) / graded.length);
  const recent = sample
    ? (zh ? [['情意題：我與外婆的距離', '18/25'], ['知性題：標籤的兩面', '15/25']] : [['A Time I Helped Someone', '14/20'], ['My Ideal Weekend', '16/20']])
    : graded.slice(-2).reverse().map((e) => [e.title, `${fmtNum(e.scoreTotal)}/${fmtNum(e.scoreMax)}`]);
  const stamp = zh ? 'A+' : '特優';
  const trust = zh
    ? ['三等六級', '先定等再定級', '知性題', '情意題', '斟酌扣分']
    : ['Content', 'Organization', 'Grammar', 'Vocabulary', 'Mechanics'];

  main.innerHTML = `
    <section class="hero">
      <div class="hero-text">
        <span class="eyebrow">${zh ? '國文區・學測國寫' : '英文區・學測英文作文'}</span>
        <h1>${zh ? '用學測的標準，<br>看懂你的每一篇作文' : '用學測的標準，<br>寫出拿高分的英文作文'}</h1>
        <p class="lead">${zh
          ? '上傳作文與題目的照片，或直接貼上文字，依大考中心國寫評分原則批改：分數、評語、可進步之處、滿分改寫，一次整理好。看不懂的地方，直接問到懂。'
          : '上傳作文與題目的照片，或直接貼上文字，依大考中心分項式評分批改：內容、組織、文法句構、字彙拼字、體例，滿分 20 分。改完還能繼續追問。'}</p>
        <div class="hero-actions">
          <button class="btn primary lg" data-action="new-essay">開始批改</button>
          <a class="btn-text" href="#how"><span class="play">${I.play}</span>怎麼使用</a>
        </div>
      </div>

      <div class="hero-art" aria-hidden="true">
        <div class="art-blob"></div>
        <span class="art-spark s1">${I.spark}</span>
        <span class="art-spark s2">${I.spark}</span>
        <div class="art-paper">
          <div class="paper-title"></div>
          ${Array.from({ length: 7 }, (_, i) => `<div class="paper-line" style="width:${[92, 86, 95, 70, 90, 84, 60][i]}%"></div>`).join('')}
          <div class="paper-stamp">${stamp}</div>
        </div>
        <div class="float f-total">
          <span class="f-icon">${I.doc}</span>
          <b>已批改</b><small>${sample ? '範例' : ''} ${sample ? 6 : graded.length} 篇</small>
        </div>
        <div class="float f-dark">
          <span class="f-icon light">${I.chat}</span>
          <div><b>平均得分率</b><small>${avg}%</small></div>
        </div>
        <div class="float f-recent">
          <b class="f-head">最近批改</b>
          ${recent.map(([t, s], i) => `
            <div class="f-row"><span class="f-av">${i ? I.doc : I.check}</span><div><span>${esc(t)}</span><small>${s}</small></div></div>`).join('')}
        </div>
        <div class="float f-chart">
          <div class="f-chart-head"><b>得分趨勢</b><span class="f-tag">${sample ? '範例' : '近 6 篇'}</span></div>
          <div class="bars">${trend.map((v) => `<span style="height:${Math.max(8, v)}%"></span>`).join('')}</div>
        </div>
      </div>
    </section>

    <section class="trust">
      <p>依據大考中心公布的${zh ? '國寫' : '英文作文'}評分原則</p>
      <div class="trust-row">${trust.map((t) => `<span>${t}</span>`).join('')}</div>
    </section>

    <section class="feature" id="how">
      <div class="feature-art" aria-hidden="true">
        <span class="art-spark s3">${I.spark}</span>
        <div class="fa-card fa-report">
          <div class="f-chart-head"><b>${zh ? '各題得分' : '分項得分'}</b><span class="f-tag">本篇</span></div>
          ${(zh ? [['問題（一）', 75], ['問題（二）', 71]] : [['內容', 80], ['組織', 80], ['文法句構', 50], ['字彙拼字', 75]])
            .map(([n, v]) => `<div class="fa-bar"><span>${n}</span><i><em style="width:${v}%"></em></i></div>`).join('')}
        </div>
        <div class="fa-card fa-dark"><span class="f-icon light">${I.chat}</span><div><b>對話紀錄</b><small>已存進這篇作文</small></div></div>
        <div class="fa-card fa-diff">
          <b class="f-head">可進步之處</b>
          <div class="fa-before">${zh ? '我發現我應該多陪陪外婆。' : 'He is carrying a heavy bag.'}</div>
          <div class="fa-after">${zh ? '原來距離，是我默默把她排進了「有空再說」。' : 'He was carrying a heavy bag.'}</div>
        </div>
      </div>
      <div class="feature-text">
        <h2>批改完，<br>還能一直追問到懂。</h2>
        <p class="lead">每一篇作文都是一個獨立檔案：照片、批改、筆記和對話紀錄全部存在一起，隨時回來複習。</p>
        <ul class="check-list">
          <li><span>${I.arrow}</span>新增作文，上傳照片或貼上文字（作文、題目都可以），再加上備註</li>
          <li><span>${I.arrow}</span>分數、評語、可進步之處、滿分改寫分頁整理</li>
          <li><span>${I.arrow}</span>原句和建議並排對照，一眼看出差在哪</li>
          <li><span>${I.arrow}</span>不懂或不同意，直接在對話框問 AI</li>
        </ul>
        <button class="btn primary" data-action="new-essay">新增${SUBJECTS[state.subject].name}作文</button>
      </div>
    </section>`;
}

// ---------- 作文頁 ----------
function renderEssay(essay) {
  const r = essay.result;
  const showUpload = !r || state.uploadOpen;
  main.innerHTML = `
    <div class="essay-layout ${state.chatOpenMobile ? 'chat-open' : ''}">
      <section class="essay-main">
        <header class="essay-head">
          <div class="crumb"><a href="#/${essay.subject}">${SUBJECTS[essay.subject].name}</a><span>/</span>作文檔案</div>
          <div class="essay-head-top">
            <input class="title-input" id="titleInput" value="${esc(essay.title)}" maxlength="60" aria-label="作文標題" />
            <div class="essay-head-actions">
              ${r ? `<button class="btn outline sm" data-action="toggle-upload">${I.image}${state.uploadOpen ? '收起' : '作文內容與備註'}</button>` : ''}
              <button class="btn outline sm danger-text" data-action="delete-essay">刪除</button>
            </div>
          </div>
          <div class="essay-meta">
            <span class="chip subj">${SUBJECTS[essay.subject].full}</span>
            <span>建立於 ${fmtDate(essay.createdAt)}</span>
            ${essay.gradedAt ? `<span class="sep">•</span><span>批改於 ${fmtDate(essay.gradedAt)}</span>` : ''}
          </div>
        </header>

        ${showUpload ? renderUpload(essay) : ''}
        ${essay.status === 'grading' ? renderGrading(essay) : ''}
        ${essay.status === 'error' ? `<div class="card error-card"><div><b>批改失敗</b><p>${esc(essay.error)}</p></div><button class="btn primary sm" data-action="grade">再試一次</button></div>` : ''}
        ${r ? renderResult(essay) : ''}
      </section>

      <aside class="chat-panel" id="chatPanel">${renderChat(essay)}</aside>
      <button class="chat-fab only-tablet" data-action="toggle-chat">${state.chatOpenMobile ? I.close : `${I.chat}<span>問 AI</span>`}</button>
    </div>`;
  bindEssayInputs(essay);
  hydrateImages();
  scrollChatToBottom();
}

// 字數：國文算字（含標點、不含空白），英文算單詞（和後端一致）
function countText(subject, text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return subject === 'en' ? t.split(/\s+/).length : Array.from(t.replace(/\s/g, '')).length;
}

function renderUpload(essay) {
  const grading = essay.status === 'grading';
  const en = essay.subject === 'en';
  const unit = en ? 'words' : '字';
  const imgs = (kind) => essay[kind].map((imgId, i) => `
    <div class="thumb">
      <img data-img-id="${esc(imgId)}" alt="" data-action="zoom" data-src-kind="${kind}" data-index="${i}" />
      <span class="thumb-no">${i + 1}</span>
      ${grading ? '' : `<button class="thumb-x" data-action="remove-img" data-kind="${kind}" data-index="${i}" aria-label="移除">${I.close}</button>`}
    </div>`).join('');
  const addTile = (kind) => grading ? '' : `
    <label class="thumb add">
      <input type="file" accept="image/*" multiple data-upload="${kind}" hidden />
      <span>＋</span><small>新增照片</small>
    </label>`;
  const textArea = (box, placeholder, rows) => {
    const val = essay[box + 'Text'] || '';
    const n = countText(essay.subject, val);
    return `<textarea id="${box}TextInput" class="box-text" rows="${rows}" placeholder="${esc(placeholder)}" ${grading ? 'disabled' : ''}>${esc(val)}</textarea>
      <small class="count-line"><span id="${box}Count">${n ? `${n} ${unit}` : ''}</span></small>`;
  };

  const hasEssayText = !!String(essay.essayText || '').trim();
  const hasTopicText = !!String(essay.topicText || '').trim();
  // 作文同時有照片和文字時，請使用者說明兩者的關係
  const mixBox = essay.essayImages.length && hasEssayText ? `
    <div class="mix-box">
      <b>照片和文字的關係</b>
      <label><input type="radio" name="essayMix" value="same" ${essay.essayMix !== 'append' ? 'checked' : ''} ${grading ? 'disabled' : ''} />
        <span>同一篇：照片是手寫版、文字是電子版<small>以文字為準，照片只當核對用</small></span></label>
      <label><input type="radio" name="essayMix" value="append" ${essay.essayMix === 'append' ? 'checked' : ''} ${grading ? 'disabled' : ''} />
        <span>接續：照片是前半、文字是後半<small>合起來才是一篇完整的作文</small></span></label>
    </div>` : '';
  const ocrLine = !en && hasEssayText && (essay.ocrInfo || []).length
    ? `<small class="count-line">稿紙格線偵測：${essay.ocrInfo.map((o) => `${esc(o.sheet)} 使用 ${o.lines} 行、約 ${o.chars} 字${o.unclear ? `、${o.unclear} 格看不清楚` : ''}`).join('；')}（批改時會拿來核對行數限制）</small>` : '';
  const topicBoth = essay.topicImages.length && hasTopicText
    ? '<small class="mode-hint">題目的文字和照片會一起提供給老師。</small>' : '';

  const essayPh = en ? 'Paste or type your essay here…' : '貼上或輸入作文內容。有多個小題時，可以用（一）、（二）分開。';
  const topicPh = '貼上題目全文，包含各小題要求、字數限制與配分。';
  return `
    <section class="card upload-card">
      <div class="upload-grid">
        <div class="upload-box b1" ${grading ? '' : 'data-drop="essayImages"'}>
          <div class="upload-label"><b>作文</b><span class="tag dark">照片、文字都可以</span></div>
          <div class="box-sub"><span>照片</span><small>可多張，也可以直接拖進來。直式稿紙字很小時，可左右半邊各拍一張（先傳右半）</small></div>
          <div class="thumbs">${imgs('essayImages')}${addTile('essayImages')}</div>
          ${essay.essayImages.length && !grading ? `<div class="ocr-bar">${en ? '' : '<button class="btn primary sm" data-action="grid-ocr">📐 稿紙格線辨識（建議）</button>'}<button class="btn outline sm" data-action="transcribe">✨ ${en ? '辨識照片，轉成文字' : '整頁快速辨識'}</button><small>${en ? '手寫作文建議先辨識，對照照片修正後再批改。辨識錯了，分數也會跟著錯。' : '國寫直式稿紙請用「格線辨識」：逐格讀字、準很多，也能量出實際用了幾行。「整頁快速辨識」是一次丟給模型讀，適合不是標準稿紙的照片。'}</small></div>` : ''}
          ${en ? `<div class="box-sub"><span>文字</span><small>可單獨使用，也可以和照片並用</small></div>
          ${textArea('essay', essayPh, 6)}
          ${ocrLine}` : renderZhTextBox({ essay, grading, placeholder: essayPh })}
          ${mixBox}
        </div>
        <div class="upload-box b2" ${grading ? '' : 'data-drop="topicImages"'}>
          <div class="upload-label"><b>題目</b><span class="tag">建議</span></div>
          <div class="box-sub"><span>照片</span><small>有題目，評分才能準確扣題、對到配分</small></div>
          <div class="thumbs">${imgs('topicImages')}${addTile('topicImages')}</div>
          <div class="box-sub"><span>文字</span><small>題目有電子檔就直接貼</small></div>
          ${textArea('topic', topicPh, 4)}
          ${topicBoth}
        </div>
      </div>
      <label class="note-field">
        <span><b>備註</b><small>選填・想特別請老師注意的地方</small></span>
        <textarea id="noteInput" rows="2" placeholder="${SUBJECTS[essay.subject].placeholder}" ${grading ? 'disabled' : ''}>${esc(essay.note)}</textarea>
      </label>
      <div class="grade-bar">
        <span class="grade-plan">${quotaText()}</span>
        <button class="btn primary" data-action="grade" ${grading ? 'disabled' : ''}>${essay.result ? '重新批改' : '開始批改'} ${I.arrow}</button>
      </div>
    </section>`;
}

function renderGrading(essay) {
  if (essay.phase === 'ocr') {
    return `
    <section class="card grading-card">
      <div class="spinner"></div>
      <div>
        <b>正在辨識照片…</b>
        <p class="grading-steps"><span>找出每一欄</span><span>由右到左逐字讀</span><span>檢查有沒有讀錯</span></p>
        <small>大約 20 秒到 1 分鐘。完成後文字會自動填進「作文文字」，請對照照片檢查、修改。</small>
      </div>
    </section>`;
  }
  return `
    <section class="card grading-card">
      <div class="spinner"></div>
      <div>
        <b>老師批改中…</b>
        <p class="grading-steps"><span>辨識字跡</span><span>對照題目</span><span>定等定級</span><span>撰寫評語與改寫</span></p>
        <small>大約 30 秒到 2 分鐘。可以先去看別篇，批改完會自動存好。</small>
      </div>
    </section>`;
}

function pendingBlock(essay) {
  if (essay.phase === 'rewrite') {
    return `<section class="card grading-card"><div class="spinner"></div><div><b>正在撰寫滿分範文與筆記…</b><p><small>通常再等半分鐘左右，完成後會自動出現。</small></p></div></section>`;
  }
  return `<section class="card error-card"><div><b>範文與筆記還沒有產生</b><p>${esc(essay.error || '可能是 AI 暫時忙碌。')}</p></div><button class="btn primary sm" data-action="rewrite">重新產生</button></section>`;
}

function quotaText() {
  const me = state.me;
  if (!me) return '';
  const left = Math.max(0, me.limits.grades - me.used.grades);
  return `今日還可批改 <b>${left}</b> 次（上限 ${me.limits.grades}）`;
}

// ---------- 批改結果 ----------
function renderResult(essay) {
  const r = essay.result;
  return `
    <nav class="result-tabs" role="tablist">
      ${TABS.map((t) => `
        <button role="tab" class="${state.tab === t.id ? 'active' : ''}" data-action="tab" data-tab="${t.id}">
          ${t.label}${t.id === 'improve' && r.improvements.length ? `<span class="count">${r.improvements.length}</span>` : ''}
        </button>`).join('')}
    </nav>
    <div class="result-panel">${renderTab(essay)}</div>`;
}

function renderTab(essay) {
  const r = essay.result;
  switch (state.tab) {
    case 'improve': return renderImprove(r);
    case 'rewrite': return renderRewrite(r, essay);
    case 'notes': return renderNotes(essay);
    case 'original': return renderOriginal(essay);
    default: return renderOverview(r);
  }
}

function levelScale(level) {
  const levels = state.subject === 'en'
    ? [['劣', '0–4'], ['差', '5–9'], ['可', '10–14'], ['優', '15–18'], ['特優', '19–20']]
    : [['C', ''], ['C+', ''], ['B', ''], ['B+', ''], ['A', ''], ['A+', '']];
  const norm = String(level || '').replace(/\s|級|等/g, '').toUpperCase().replace('＋', '+');
  return `<div class="level-scale">${levels.map(([l, range]) =>
    `<span class="${norm === l.toUpperCase() ? 'on' : ''}">${l}${range ? `<small>${range}</small>` : ''}</span>`).join('')}</div>`;
}

function renderOverview(r) {
  const pct = r.score.max ? Math.round((r.score.total / r.score.max) * 100) : 0;
  return `
    <div class="score-hero">
      <div class="score-big">
        <span class="score-label">總分</span>
        <div><b>${fmtNum(r.score.total)}</b><span>/ ${fmtNum(r.score.max)}</span></div>
        <div class="score-meter"><i style="width:${pct}%"></i></div>
      </div>
      <div class="score-info">
        <span class="level-pill">${esc(r.score.level || '—')}</span>
        <p class="score-summary">${esc(r.score.summary)}</p>
        ${levelScale(r.score.level)}
      </div>
    </div>

    <div class="card tint-1">
      <div class="card-head"><h3>${state.subject === 'en' ? '分項得分' : '各題得分'}</h3><span class="tag">${r.breakdown.length} 項</span></div>
      <div class="breakdown">
        ${r.breakdown.map((b) => `
          <div class="bd-row">
            <div class="bd-head">
              <span class="bd-item">${esc(b.item)}${b.level ? ` <span class="tag dark">${esc(b.level)}</span>` : ''}</span>
              <span class="bd-score"><b>${fmtNum(b.score)}</b> / ${fmtNum(b.max)}</span>
            </div>
            <div class="bar"><span style="width:${b.max ? Math.min(100, (b.score / b.max) * 100) : 0}%"></span></div>
            <p class="bd-comment">${esc(b.comment)}</p>
          </div>`).join('')}
      </div>
      ${r.deductions.length ? `
        <div class="deductions">
          <b>斟酌扣分</b>
          ${r.deductions.map((d) => `<div class="ded-row"><span>${esc(d.reason)}</span><span class="minus">−${fmtNum(d.points)}</span></div>`).join('')}
        </div>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><h3>老師評語</h3></div>
      <p class="overall">${esc(r.comments.overall)}</p>
    </div>

    <div class="two-col">
      <div class="card tint-2">
        <div class="card-head"><h3>做得好的地方</h3></div>
        <ul class="tick-list">${r.comments.strengths.map((s) => `<li><span>${I.check}</span>${esc(s)}</li>`).join('') || '<li>—</li>'}</ul>
      </div>
      <div class="card tint-3">
        <div class="card-head"><h3>主要問題</h3></div>
        <ul class="tick-list">${r.comments.weaknesses.map((s) => `<li><span>${I.arrow}</span>${esc(s)}</li>`).join('') || '<li>—</li>'}</ul>
      </div>
    </div>`;
}

function renderImprove(r) {
  const cats = ['全部', ...new Set(r.improvements.map((i) => i.category))];
  if (!cats.includes(state.improveFilter)) state.improveFilter = '全部';
  const list = r.improvements.filter((i) => state.improveFilter === '全部' || i.category === state.improveFilter);
  const sevClass = (s) => (/高/.test(s) ? 'high' : /低/.test(s) ? 'low' : 'mid');
  return `
    <div class="filter-chips">
      ${cats.map((c) => {
        const n = c === '全部' ? r.improvements.length : r.improvements.filter((i) => i.category === c).length;
        return `<button class="fchip ${state.improveFilter === c ? 'on' : ''}" data-action="filter" data-cat="${esc(c)}">${esc(c)}<small>${n}</small></button>`;
      }).join('')}
    </div>
    <div class="improve-list">
      ${list.map((i, idx) => `
        <article class="card improve-card">
          <div class="improve-top">
            <span class="improve-no">${idx + 1}</span>
            <span class="tag">${esc(i.category)}</span>
            <span class="sev ${sevClass(i.severity)}">影響${esc(i.severity.replace(/影響/, ''))}</span>
          </div>
          <div class="diff">
            <div class="diff-row before"><span class="diff-tag">原句</span><p>${esc(i.original)}</p></div>
            <div class="diff-row after"><span class="diff-tag">建議</span><p>${esc(i.suggestion)}</p></div>
          </div>
          <p class="why"><b>為什麼</b>${esc(i.explanation)}</p>
          <button class="btn-text sm" data-action="ask" data-q="${esc(`關於第 ${idx + 1} 點「${i.original.slice(0, 30)}」，可以再多解釋一點，並給我另一種改法嗎？`)}">${I.chat}針對這點問 AI</button>
        </article>`).join('') || '<p class="muted">這個分類沒有項目。</p>'}
    </div>`;
}

function renderRewrite(r, essay) {
  if (!r.rewrite.text) return pendingBlock(essay);
  const en = state.subject === 'en' ? 'en' : '';
  return `
    <div class="card">
      <div class="rewrite-top">
        <div class="seg">
          <button class="${state.rewriteView === 'rewrite' ? 'on' : ''}" data-action="rewrite-view" data-view="rewrite">滿分範文</button>
          <button class="${state.rewriteView === 'compare' ? 'on' : ''}" data-action="rewrite-view" data-view="compare">對照原文</button>
        </div>
        <button class="btn outline sm" data-action="copy-rewrite">複製範文</button>
      </div>
      ${state.rewriteView === 'compare'
        ? `<div class="compare">
             <div><span class="tag">我的原文</span><div class="prose ${en}">${esc(r.transcription)}</div></div>
             <div><span class="tag dark">滿分改寫</span><div class="prose ${en} hl">${esc(r.rewrite.text)}</div></div>
           </div>`
        : `<div class="prose ${en} rewrite-text">${esc(r.rewrite.text)}</div>`}
    </div>
    ${r.rewrite.highlights.length ? `
      <div class="card tint-1">
        <div class="card-head"><h3>改寫重點</h3></div>
        <ol class="num-list">${r.rewrite.highlights.map((h, i) => `<li><span>${i + 1}</span><p>${esc(h)}</p></li>`).join('')}</ol>
      </div>` : ''}`;
}

function renderNotes(essay) {
  const r = essay.result;
  return `
    ${r.notes.length ? '' : pendingBlock(essay)}
    <div class="notes-grid">
      ${r.notes.map((n, i) => `
        <div class="card note-card tint-${(i % 3) + 1}">
          <h3>${esc(n.title)}</h3>
          <ul class="dot-list">${n.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        </div>`).join('')}
    </div>
    <div class="card my-notes">
      <div class="card-head"><h3>我的筆記</h3><small class="muted" id="notesSaved">自動儲存</small></div>
      <textarea id="myNotesInput" rows="8" placeholder="把想記住的東西寫在這裡：常錯的字、好用的句子、下次要注意的事…">${esc(essay.myNotes)}</textarea>
    </div>`;
}

function renderOriginal(essay) {
  const r = essay.result;
  const en = state.subject === 'en' ? 'en' : '';
  const hasText = !!String(essay.essayText || '').trim();
  const src = !hasText ? 'photo' : (essay.essayImages.length && essay.essayMix === 'append' ? 'append' : 'text');
  const gallery = (kind, label) => essay[kind].length
    ? `<div class="gallery"><span class="tag">${label}</span><div class="thumbs">${essay[kind].map((imgId, i) => `<div class="thumb"><img data-img-id="${esc(imgId)}" alt="" data-action="zoom" data-src-kind="${kind}" data-index="${i}" /></div>`).join('')}</div></div>`
    : '';
  return `
    <div class="card tint-1">
      <div class="card-head"><h3>題目</h3></div>
      <div class="prose">${esc(r.topic_text || '（未辨識到題目）')}</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${src === 'photo' ? '作文原文辨識' : '作文原文'}</h3><small class="muted">${r.word_count ? `約 ${r.word_count} ${en ? 'words' : '字'}` : ''}</small></div>
      ${{ text: '<p class="muted small">這是你貼上的文字，沒有經過辨識。</p>',
          append: '<p class="muted small">前半是照片辨識的結果（［？］表示 AI 看不清楚的字），後半是你貼上的文字，中間以空行分開。</p>',
          photo: '<p class="muted small">［？］表示 AI 看不清楚的字。辨識有誤的話，可以在對話框告訴 AI 正確內容。</p>' }[src]}
      <div class="prose ${en}">${esc(r.transcription)}</div>
    </div>
    ${essay.note ? `<div class="card"><div class="card-head"><h3>我的備註</h3></div><p>${esc(essay.note)}</p></div>` : ''}
    ${essay.topicImages.length + essay.essayImages.length ? `<div class="card">${gallery('topicImages', '題目照片')}${gallery('essayImages', '作文照片')}</div>` : ''}`;
}

// ---------- 對話框 ----------
function renderChat(essay) {
  const ready = !!essay.result;
  const msgs = essay.chat || [];
  const sending = state.chatBusy.has(essay.id);
  return `
    <div class="chat-head">
      <span class="chat-avatar">${I.chat}</span>
      <div><b>和 AI 討論這篇</b><small>${msgs.length ? `${msgs.length} 則紀錄・已自動儲存` : '對話會存在這篇作文裡'}</small></div>
    </div>
    <div class="chat-body" id="chatBody">
      ${!ready
        ? '<div class="chat-empty">批改完成後，就可以在這裡針對這篇作文繼續提問。</div>'
        : msgs.length === 0
          ? `<div class="chat-empty">
               有不懂或不同意的地方，都可以問我。
               <div class="quick-asks">${QUICK_ASKS[essay.subject].map((q) => `<button class="qa" data-action="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
             </div>`
          : msgs.map(renderMsg).join('')}
      ${sending ? '<div class="msg assistant"><div class="bubble typing"><span></span><span></span><span></span></div></div>' : ''}
    </div>
    <form class="chat-input" id="chatForm">
      <textarea id="chatText" rows="1" placeholder="${ready ? '問問題…（Enter 送出）' : '批改完成後才能提問'}" ${ready && !sending ? '' : 'disabled'}></textarea>
      <button class="send-btn" type="submit" aria-label="送出" ${ready && !sending ? '' : 'disabled'}>${I.arrow}</button>
    </form>`;
}

function renderMsg(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  return `<div class="msg assistant"><div class="bubble md">${md(m.content)}</div></div>`;
}

function scrollChatToBottom() {
  const b = $('#chatBody');
  if (b) b.scrollTop = b.scrollHeight;
}

function rerenderChat(essay) {
  const panel = $('#chatPanel');
  if (!panel) return;
  panel.innerHTML = renderChat(essay);
  bindChatInput();
  scrollChatToBottom();
}

async function sendChat(text) {
  const message = String(text || '').trim();
  const id = state.currentId;
  if (!message || !id || state.chatBusy.has(id)) return;
  const essay = store.peekEssay(id);
  if (!essay?.result) return;
  if (message.length > 4000) return toast('訊息太長了（上限 4000 字）', 'error');

  const userMsg = { role: 'user', content: message, ts: Date.now() };
  essay.chat.push(userMsg);
  state.chatBusy.add(id);
  rerenderChat(essay);

  let failed = false;
  try {
    const { reply, ts } = await api.chat(id, message); // 後端會自己存起來，並用資料庫裡的批改結果當背景
    const cur = store.peekEssay(id) || essay;
    cur.chat.push({ role: 'assistant', content: reply, ts: ts || Date.now() });
    updateMeta(id, { chatCount: cur.chat.length });
    refreshMe();
  } catch (err) {
    failed = true;
    const cur = store.peekEssay(id) || essay;
    const i = cur.chat.indexOf(userMsg);
    if (i >= 0) cur.chat.splice(i, 1);
    handleApiError(err);
  } finally {
    state.chatBusy.delete(id);
    if (state.currentId === id) {
      rerenderChat(store.peekEssay(id) || essay);
      if (failed) { const ta = $('#chatText'); if (ta) ta.value = message; }
    }
  }
}

// ---------- 設定頁 ----------
function renderSettings() {
  const s = theme.loadSettings();
  const c = theme.currentColors(s);
  const custom = s.custom || c;
  const swatch = (p) => `<span class="sw" style="background:${p.p1}"></span><span class="sw" style="background:${p.p2}"></span><span class="sw" style="background:${p.p3}"></span><span class="sw" style="background:${p.ink}"></span>`;
  const colorFields = [['p1', '主色 1'], ['p2', '主色 2'], ['p3', '主色 3'], ['ink', '文字與按鈕']];
  const seg = (action, current, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${current === v ? 'on' : ''}" data-action="${action}" data-v="${v}">${l}</button>`).join('')}</div>`;

  main.innerHTML = `
    <section class="settings">
      <header class="settings-head">
        <span class="eyebrow">設定</span>
        <h1>讓網站變成你喜歡的樣子</h1>
        <p class="lead">外觀設定只存在這台裝置，改了會立刻套用。</p>
      </header>

      <div class="card set-card">
        <div class="card-head"><div><h3>配色主題</h3><p class="muted small">選一組顏色，整個網站立刻換上。</p></div></div>
        <div class="preset-grid" id="presetGrid">
          ${theme.PRESETS.map((p) => `
            <button class="preset ${s.preset === p.id ? 'on' : ''}" data-action="set-preset" data-id="${p.id}">
              <span class="preset-sw">${swatch(p)}</span>
              <span class="preset-name">${p.name}<i>${I.check}</i></span>
            </button>`).join('')}
          <button class="preset ${s.preset === 'custom' ? 'on' : ''}" data-action="set-preset" data-id="custom" id="customPreset">
            <span class="preset-sw">${swatch(custom)}</span>
            <span class="preset-name">自訂<i>${I.check}</i></span>
          </button>
        </div>
      </div>

      <div class="card set-card">
        <div class="card-head"><div><h3>自訂配色</h3><p class="muted small">調整任何一個顏色，就會切換成「自訂」主題。</p></div></div>
        <div class="color-grid">
          ${colorFields.map(([k, label]) => `
            <label class="color-field">
              <span class="color-dot"><input type="color" data-color-key="${k}" value="${c[k]}" /></span>
              <span><b>${label}</b><input class="hex" data-hex-key="${k}" value="${c[k].toUpperCase()}" maxlength="7" spellcheck="false" /></span>
            </label>`).join('')}
        </div>
        <div class="preview">
          <div class="pv-card tint-3"><small>總分</small><b>18<span>/25</span></b><span class="level-pill">A</span></div>
          <div class="pv-card tint-1"><small>分項得分</small><div class="bar"><span style="width:72%"></span></div><div class="bar"><span style="width:48%"></span></div></div>
          <div class="pv-card tint-2"><small>做得好的地方</small><p>善用具體物件承載情感</p></div>
          <div class="pv-card pv-btns"><button class="btn primary sm" type="button">主要按鈕</button><button class="btn outline sm" type="button">次要按鈕</button></div>
        </div>
      </div>

      <div class="two-col">
        <div class="card set-card">
          <div class="card-head"><div><h3>顯示模式</h3><p class="muted small">晚上念書可以切到深色。</p></div></div>
          ${seg('set-mode', s.mode, [['light', '淺色'], ['dark', '深色'], ['auto', '跟隨系統']])}
        </div>
        <div class="card set-card">
          <div class="card-head"><div><h3>字體大小</h3><p class="muted small">影響整個網站的文字大小。</p></div></div>
          ${seg('set-font', s.fontSize, [['s', '小'], ['m', '中'], ['l', '大']])}
        </div>
      </div>

      <div class="card set-card">
        <div class="card-head"><div><h3>帳號與用量</h3>
          <p class="muted small">${state.me
            ? `目前登入：<b>${esc(state.me.name)}</b>　今日批改 ${state.me.used.grades}/${state.me.limits.grades}　對話 ${state.me.used.chats}/${state.me.limits.chats}`
            : '尚未登入'}</p></div>
        <button class="btn outline sm" data-action="logout">切換通行碼</button></div>
      </div>

      <div class="card set-card">
        <div class="card-head"><div><h3>資料存放位置</h3>
          <p class="muted small">作文、批改結果和對話存在管理者的 Google 試算表，照片存在 Google 雲端硬碟，所以換手機、換電腦，輸入通行碼就能接著用。照片縮圖會暫存在這台裝置，登出時會清掉。</p></div></div>
      </div>

      <button class="btn-text reset" data-action="reset-theme">恢復預設外觀</button>
    </section>`;

  // 顏色選擇器：拖動時即時套用（不重畫整頁，選色器才不會被關掉）
  const onColor = (k, v) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    const cur = theme.loadSettings();
    const base = { ...theme.currentColors(cur) };
    const next = { p1: base.p1, p2: base.p2, p3: base.p3, ink: base.ink, [k]: v };
    theme.saveSettings({ ...cur, preset: 'custom', custom: next });
    main.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.id === 'custom'));
    $('#customPreset .preset-sw').innerHTML = swatch(next);
    const color = main.querySelector(`[data-color-key=${k}]`);
    const hex = main.querySelector(`[data-hex-key=${k}]`);
    if (color.value.toLowerCase() !== v.toLowerCase()) color.value = v;
    if (document.activeElement !== hex) hex.value = v.toUpperCase();
  };
  main.querySelectorAll('[data-color-key]').forEach((el) => el.addEventListener('input', () => onColor(el.dataset.colorKey, el.value)));
  main.querySelectorAll('[data-hex-key]').forEach((el) => el.addEventListener('input', () => {
    let v = el.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    onColor(el.dataset.hexKey, v);
  }));
}

// ---------- 批改 ----------
async function startGrading() {
  const id = state.currentId;
  const essay = store.peekEssay(id);
  if (!essay || essay.status === 'grading') return;
  if (!essay.essayImages.length && !String(essay.essayText || '').trim()) return toast('請先上傳作文照片，或貼上作文文字', 'error');
  if (!String(essay.essayText || '').trim() && essay.essayImages.length) {
    const zh = essay.subject !== 'en';
    const choice = await modal({
      title: '先辨識、檢查原文，再批改？',
      body: '<p>手寫字（尤其直式稿紙）有時會被誤讀。原文讀錯，分數也會跟著錯。</p><p>建議先把照片辨識成文字，你對照照片修正後再批改。' + (zh ? '國寫稿紙請用「格線辨識」，最準。' : '') + '</p>',
      actions: [{ label: '直接批改', value: 'grade' }, ...(zh ? [{ label: '整頁快速辨識', value: 'ocr' }, { label: '格線辨識（建議）', kind: 'primary', value: 'grid' }] : [{ label: '先辨識（建議）', kind: 'primary', value: 'ocr' }])],
    });
    if (choice === 'grid') return startGridOcr();
    if (choice === 'ocr') return startTranscribe();
    if (choice !== 'grade') return;
  }
  const left = essay.subject === 'en' ? 0 : countUnclear(essay.essayText);
  if (left) {
    const go = await modal({
      title: `還有 ${left} 處看不清楚的字`,
      body: '<p>作文文字裡還有標成［？］的地方。批改會把你送出的文字當成正確原文，建議先對照照片補上正確的字。</p>',
      actions: [{ label: '回去檢查', kind: 'primary', value: false }, { label: '仍要批改', value: true }],
    });
    if (!go) {
      document.querySelector('#ztb [data-ztb=next]')?.click();
      return;
    }
  }
  try {
    await store.flushAll(); // 把還沒送出的備註、題目與作文文字先存好
    const { jobId } = await api.grade(id);
    Object.assign(essay, { status: 'grading', phase: '', error: '' });
    state.uploadOpen = false;
    updateMeta(id, { status: 'grading' });
    renderEssay(essay);
    api.run(jobId).catch(() => {}); // 立刻開始執行；就算這一步失敗，後端有保險觸發器會接手
    watchEssay(id);
    refreshMe();
  } catch (err) {
    handleApiError(err);
  }
}

// 先把照片辨識成文字，讓學生對照照片修正；手寫字讀錯的話，後面的分數就跟著錯
async function startTranscribe() {
  const id = state.currentId;
  const essay = store.peekEssay(id);
  if (!essay || essay.status === 'grading') return;
  if (!essay.essayImages.length) return toast('請先上傳作文照片', 'error');
  const hasText = !!String(essay.essayText || '').trim();
  if (hasText) {
    const ok = await modal({
      title: '覆蓋目前的作文文字？',
      body: '<p>辨識的結果會取代你目前貼上或輸入的作文文字，無法復原。</p>',
      actions: [{ label: '取消', value: false }, { label: '覆蓋並辨識', kind: 'primary', value: true }],
    });
    if (!ok) return;
  }
  try {
    await store.flushAll();
    const { jobId } = await api.transcribe(id, hasText);
    Object.assign(essay, { status: 'grading', phase: 'ocr', error: '' });
    updateMeta(id, { status: 'grading' });
    renderEssay(essay);
    api.run(jobId).catch(() => {});
    watchEssay(id);
    refreshMe();
  } catch (err) {
    handleApiError(err);
  }
}

// 國寫直式稿紙：在瀏覽器切格、逐格辨識（模型與備援由後端設定），結果寫進作文文字
async function startGridOcr() {
  const id = state.currentId;
  const essay = store.peekEssay(id);
  if (!essay || essay.status === 'grading') return;
  if (essay.subject === 'en') return toast('格線辨識只適用於國寫的直式稿紙', 'error');
  if (!essay.essayImages.length) return toast('請先上傳作文照片', 'error');
  const hasText = !!String(essay.essayText || '').trim();
  openGridOcr({
    essayId: id,
    api,
    hasText,
    photos: essay.essayImages.map((imgId) => ({ load: () => store.imgSrc(id, imgId) })),
    onApply: async ({ text, mode, info }) => {
      const cur = store.peekEssay(id);
      if (!cur) return;
      const keep = (cur.ocrInfo || []).filter((o) => o.sheet !== info.sheet);
      const append = mode === 'append' && String(cur.essayText || '').trim();
      const next = append ? String(cur.essayText).replace(/\s+$/, '') + '\n\n' + text : text;
      try {
        await store.patchNow(id, { essayText: next.slice(0, 20000), essayMix: 'same', ocrInfo: append ? [...keep, info] : [info] });
        refreshMe();
        if (state.currentId === id) { state.uploadOpen = true; renderEssay(store.peekEssay(id)); }
        toast(info.unclear ? `已寫入 ${info.chars} 字，有 ${info.unclear} 處看不清楚（標成［？］）。請對照照片檢查後再批改` : `已寫入 ${info.chars} 字。請對照照片檢查後再批改`, 'success');
      } catch (err) { handleApiError(err); }
    },
  });
}

async function regenRewrite() {
  const id = state.currentId;
  const essay = store.peekEssay(id);
  if (!essay) return;
  try {
    const { jobId } = await api.rewrite(id);
    Object.assign(essay, { phase: 'rewrite', error: '' });
    renderEssay(essay);
    api.run(jobId).catch(() => {});
    watchEssay(id);
  } catch (err) {
    handleApiError(err);
  }
}

// 每 4 秒問一次後端進度：分數出來就先顯示，範文與筆記晚一點補上。
// 關掉網頁也沒關係，後端會做完；下次打開同一篇會自動接著等。
async function watchEssay(id) {
  if (state.watching.has(id)) return;
  state.watching.add(id);
  const t0 = Date.now();
  let fails = 0;
  try {
    while (Date.now() - t0 < 9 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 4000));
      let st;
      try {
        st = await api.status(id);
        fails = 0;
      } catch (err) {
        if (isAuthError(err) || ++fails >= 4) throw err;
        continue;
      }
      const cur = store.peekEssay(id);
      const changed = !cur || cur.status !== st.status || (cur.phase || '') !== (st.phase || '') || cur.updatedAt !== st.updatedAt;
      if (changed) {
        const prev = cur?.status;
        const wasOcr = cur?.phase === 'ocr';
        const fresh = await store.getEssay(id, { fresh: true });
        refreshList();
        if (wasOcr && fresh.phase !== 'ocr') { // 辨識結束：不是批改完成，要請使用者檢查文字
          if (fresh.status === 'error') toast(fresh.error || '辨識失敗', 'error');
          else {
            const n = (String(fresh.essayText).match(/［？］|\[\?\]/g) || []).length;
            toast(n ? `辨識完成：有 ${n} 處看不清楚（標成［？］）。請對照照片檢查、修改後再批改` : '辨識完成。請對照照片檢查、修改後再批改', 'success');
            if (state.currentId === id) state.uploadOpen = true; // 已批改過的作文也要把輸入區打開，才看得到文字
          }
        } else if (prev === 'grading' && fresh.status === 'done') {
          toast(`「${fresh.title}」批改完成`, 'success');
          if (state.currentId === id) state.tab = 'overview';
        } else if (prev === 'grading' && fresh.status === 'error') {
          toast(fresh.error || '批改失敗', 'error');
        }
        if (state.currentId === id && !isTyping()) renderEssay(fresh);
      }
      if (st.status !== 'grading' && !st.phase) { refreshMe(); return; }
    }
    toast('等太久了，請稍後重新整理看看結果', 'error');
  } catch (err) {
    handleApiError(err);
  } finally {
    state.watching.delete(id);
  }
}

function handleApiError(err) {
  if (isAuthError(err)) {
    api.clearCode();
    state.me = null;
    state.ready = false;
    updateUserPill();
    store.clearAll();
    toast('通行碼錯誤或已失效，請重新輸入', 'error');
    ensureLogin().then(() => { state.ready = true; route(); });
  } else {
    toast(err?.message || '發生錯誤', 'error');
  }
}

// ---------- 圖片：壓縮後存成 dataURL ----------
async function fileToDataURL(file, maxSide = 2400, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`無法讀取圖片「${file.name}」，請改用 JPG 或 PNG`));
      im.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImages(kind, files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!list.length) return;
  const id = state.currentId;
  const essay = store.peekEssay(id);
  if (!essay || essay.status === 'grading') return;
  if (essay.essayImages.length + essay.topicImages.length + list.length > 12) {
    return toast('照片最多 12 張（作文＋題目）', 'error');
  }
  const noteEl = $('#noteInput');
  if (noteEl) store.patchEssay(id, { note: noteEl.value }).catch(() => {});
  toast(`上傳照片中（${list.length} 張）…`);
  for (const f of list) {
    try {
      let dataUrl = await fileToDataURL(f, kind === 'essayImages' ? 3200 : 2400); // 作文照片解析度高一點，格線辨識才看得清楚
      for (let q = 0.75, side = 3000; dataUrl.length * 0.75 > 2.9 * 1024 * 1024 && q > 0.45; q -= 0.1, side -= 300) dataUrl = await fileToDataURL(f, side, q); // 單張上限 3MB
      const r = await api.uploadImage(id, kind, dataUrl);
      store.putImage(r.imageId, dataUrl); // 剛上傳的先放進本機快取，馬上就看得到
      essay.topicImages = r.topicImages;
      essay.essayImages = r.essayImages;
      if (state.currentId === id) renderEssay(essay);
    } catch (err) {
      handleApiError(err);
      break;
    }
  }
}

// ---------- 綁定輸入框 ----------
function bindEssayInputs(essay) {
  const id = essay.id;
  const title = $('#titleInput');
  title?.addEventListener('change', () => {
    const v = title.value.trim() || '未命名作文';
    title.value = v;
    updateMeta(id, { title: v });
    store.patchEssay(id, { title: v }).catch(handleApiError);
  });
  title?.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });

  const note = $('#noteInput');
  note?.addEventListener('input', () => store.patchEssay(id, { note: note.value }).catch(handleApiError));

  document.querySelectorAll('input[name=essayMix]').forEach((r) => {
    r.addEventListener('change', () => { if (r.checked) store.patchEssay(id, { essayMix: r.value }).catch(handleApiError); });
  });

  // 貼上文字：即時顯示字數，並自動儲存
  for (const box of ['essay', 'topic']) {
    const el = $(`#${box}TextInput`);
    el?.addEventListener('input', () => {
      const c = $(`#${box}Count`);
      const n = countText(essay.subject, el.value);
      if (c) c.textContent = n ? `${n} ${essay.subject === 'en' ? 'words' : '字'}` : '';
      store.patchEssay(id, { [`${box}Text`]: el.value }).catch(handleApiError);
    });
  }

  if (essay.subject !== 'en') { // 國文：作文文字區有貼上清理、［？］待確認清單等；題目文字只做貼上清理
    bindZhTextBox(essay);
    attachPasteClean($('#topicTextInput'));
  }

  const myNotes = $('#myNotesInput');
  myNotes?.addEventListener('input', () => {
    const s = $('#notesSaved');
    if (s) s.textContent = '儲存中…';
    store.patchEssay(id, { myNotes: myNotes.value }).then(() => {
      const s2 = $('#notesSaved');
      if (s2) { s2.textContent = '已儲存 ✓'; setTimeout(() => { const s3 = $('#notesSaved'); if (s3) s3.textContent = '自動儲存'; }, 1500); }
    }).catch(handleApiError);
  });

  document.querySelectorAll('[data-upload]').forEach((input) => {
    input.addEventListener('change', () => { addImages(input.dataset.upload, input.files); input.value = ''; });
  });
  document.querySelectorAll('[data-drop]').forEach((box) => {
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dragging'); });
    box.addEventListener('dragleave', () => box.classList.remove('dragging'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('dragging'); addImages(box.dataset.drop, e.dataTransfer.files); });
  });
  bindChatInput();
}

function bindChatInput() {
  const form = $('#chatForm');
  const ta = $('#chatText');
  if (!form || !ta) return;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ta.value;
    ta.value = '';
    grow();
    sendChat(text);
  });
}

// ---------- 帳號（通行碼） ----------
function updateUserPill() {
  const pill = $('#planPill');
  const me = state.me;
  if (me) {
    const left = Math.max(0, me.limits.grades - me.used.grades);
    pill.innerHTML = `<span class="pill-dot on"></span>${esc(me.name)}<small class="pill-quota">剩 ${left} 次</small>`;
  } else {
    pill.innerHTML = '<span class="pill-dot free"></span>未登入';
  }
  pill.classList.toggle('paid', !!me);
}

async function refreshMe() {
  try { state.me = await api.me(); updateUserPill(); } catch {}
}

// 登入／連線視窗：required = true 時一定要完成才能關閉
async function openAccountModal(required = false) {
  if (state.loginOpen) return false;
  state.loginOpen = true;
  try {
    for (;;) {
      const needUrl = !api.baseLocked();
      const result = await modal({
        title: required ? '登入作文批改室' : '切換通行碼',
        body: `
          ${needUrl ? `<p class="muted small" style="margin:0 0 4px">後端網址（管理者會給你，結尾是 /exec）</p>
          <input class="text-input" id="baseInput" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(api.getBase())}" spellcheck="false" autocomplete="off" />` : ''}
          <p class="muted small" style="margin:${needUrl ? 12 : 0}px 0 4px">通行碼</p>
          <input class="text-input" id="codeInput" type="password" placeholder="向管理者索取的通行碼" autocomplete="current-password" />
          <label class="check" style="margin-top:10px"><input type="checkbox" id="showCode" /> 顯示通行碼</label>
          <p class="pw-err" id="pwErr"></p>`,
        actions: [
          ...(required ? [] : [{ label: '取消', value: null }]),
          {
            label: '連線',
            kind: 'primary',
            onClick: async (wrap, btn) => {
              const err = wrap.querySelector('#pwErr');
              const base = needUrl ? wrap.querySelector('#baseInput').value.trim() : api.getBase();
              const code = wrap.querySelector('#codeInput').value.trim();
              if (!api.looksLikeUrl(base)) { err.textContent = '網址看起來不對：要以 https://script.google.com/ 開頭、/exec 結尾'; return false; }
              if (!code) { err.textContent = '請輸入通行碼'; return false; }
              btn.disabled = true; btn.textContent = '連線中…'; err.textContent = '';
              try {
                const me = await api.verify(base, code);
                if (needUrl) api.setBase(base);
                api.setCode(code);
                state.me = me;
                return true;
              } catch (e) {
                err.textContent = e.message;
                btn.disabled = false; btn.textContent = '連線';
                return false;
              }
            },
          },
        ],
        onMount: (wrap) => {
          const submit = () => wrap.querySelector('.modal-actions .primary').click();
          wrap.querySelectorAll('input.text-input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
          wrap.querySelector('#showCode').addEventListener('change', (e) => { wrap.querySelector('#codeInput').type = e.target.checked ? 'text' : 'password'; });
          setTimeout(() => (wrap.querySelector('#baseInput') && !wrap.querySelector('#baseInput').value ? wrap.querySelector('#baseInput') : wrap.querySelector('#codeInput')).focus(), 40);
        },
      });
      if (result) { updateUserPill(); return true; }
      if (!required) return false;
    }
  } finally {
    state.loginOpen = false;
  }
}

// 啟動時：有網址和通行碼就直接驗證；否則跳出登入視窗
async function ensureLogin() {
  if (api.isConfigured() && api.getCode()) {
    try {
      state.me = await api.me();
      updateUserPill();
      return true;
    } catch (err) {
      if (!isAuthError(err)) { toast(err.message, 'error'); return true; } // 網路問題：先進去，之後可重試
      api.clearCode();
    }
  }
  return openAccountModal(true);
}

// ---------- 新增 / 刪除 ----------
async function createEssay() {
  if (state.view === 'settings') state.view = 'subject';
  const d = new Date();
  const def = `${SUBJECTS[state.subject].name}作文 ${d.getMonth() + 1}/${d.getDate()}`;
  const title = await modal({
    title: `新增${SUBJECTS[state.subject].name}作文`,
    body: `<input class="text-input" id="newTitle" value="${esc(def)}" maxlength="60" placeholder="例如：115學測 情意題" />
           <p class="muted small" style="margin-top:8px">之後也可以隨時改名。</p>`,
    actions: [
      { label: '取消', value: null },
      { label: '建立', kind: 'primary', onClick: (wrap) => wrap.querySelector('#newTitle').value.trim() || def },
    ],
    onMount: (wrap) => {
      const inp = wrap.querySelector('#newTitle');
      inp.select();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') wrap.querySelector('.modal-actions .primary').click(); });
    },
  });
  if (!title) return;
  try {
    const essay = await store.createEssay(state.subject, title);
    location.hash = `#/${state.subject}/${essay.id}`;
  } catch (err) {
    handleApiError(err);
  }
}

async function removeEssay() {
  const essay = store.peekEssay(state.currentId);
  if (!essay) return;
  const ok = await modal({
    title: '刪除這篇作文？',
    body: `<p>「${esc(essay.title)}」的照片、批改結果、筆記和對話紀錄都會一起刪除，無法復原。</p>`,
    actions: [{ label: '取消', value: false }, { label: '刪除', kind: 'danger', value: true }],
  });
  if (!ok) return;
  try {
    await store.deleteEssay(essay.id);
    toast('已刪除');
    location.hash = `#/${state.subject}`;
  } catch (err) {
    handleApiError(err);
  }
}

async function zoomImage(imageId) {
  try {
    const src = await store.imgSrc(state.currentId, imageId);
    modal({ body: `<img class="zoom-img" src="${src}" alt="" />`, wide: true, actions: [{ label: '關閉', value: null }] });
  } catch {
    toast('照片載入失敗', 'error');
  }
}

function setChatOpen(open) {
  state.chatOpenMobile = open;
  $('.essay-layout')?.classList.toggle('chat-open', open);
  const fab = $('.chat-fab');
  if (fab) fab.innerHTML = open ? I.close : `${I.chat}<span>問 AI</span>`;
  scrollChatToBottom();
}

// ---------- 全域點擊事件 ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'new-essay': return createEssay();
    case 'delete-essay': return removeEssay();
    case 'grade': return startGrading();
    case 'rewrite': return regenRewrite();
    case 'transcribe': return startTranscribe();
    case 'grid-ocr': return startGridOcr();
    case 'reload': return renderMain();
    case 'open-account': return openAccountModal(!state.me);
    case 'logout': {
      api.clearCode();
      state.me = null;
      state.ready = false;
      await store.clearAll();
      updateUserPill();
      history.replaceState(null, '', '#/zh');
      await ensureLogin();
      state.ready = true;
      return route();
    }
    case 'toggle-sidebar': return document.body.classList.toggle('sidebar-open');
    case 'toggle-upload': state.uploadOpen = !state.uploadOpen; return renderMain();
    case 'toggle-chat': return setChatOpen(!state.chatOpenMobile);
    case 'tab': state.tab = el.dataset.tab; return renderMain();
    case 'filter': state.improveFilter = el.dataset.cat; return renderMain();
    case 'rewrite-view': state.rewriteView = el.dataset.view; return renderMain();
    case 'set-preset': {
      const s = theme.loadSettings();
      if (el.dataset.id === 'custom' && !s.custom) s.custom = { ...theme.currentColors(s) };
      theme.saveSettings({ ...s, preset: el.dataset.id });
      return renderSettings();
    }
    case 'set-mode': theme.saveSettings({ ...theme.loadSettings(), mode: el.dataset.v }); return renderSettings();
    case 'set-font': theme.saveSettings({ ...theme.loadSettings(), fontSize: el.dataset.v }); return renderSettings();
    case 'reset-theme': theme.resetSettings(); toast('已恢復預設外觀'); return renderSettings();
    case 'copy-rewrite': {
      const essay = store.peekEssay(state.currentId);
      try { await navigator.clipboard.writeText(essay.result.rewrite.text); toast('已複製範文', 'success'); }
      catch { toast('複製失敗，請手動選取', 'error'); }
      return;
    }
    case 'remove-img': {
      const id = state.currentId;
      const essay = store.peekEssay(id);
      if (!essay) return;
      const kind = el.dataset.kind;
      const imageId = essay[kind][Number(el.dataset.index)];
      const noteEl = $('#noteInput');
      if (noteEl) store.patchEssay(id, { note: noteEl.value }).catch(() => {});
      try {
        const r = await api.removeImage(id, kind, imageId);
        essay.topicImages = r.topicImages;
        essay.essayImages = r.essayImages;
        if (state.currentId === id) renderEssay(essay);
      } catch (err) {
        handleApiError(err);
      }
      return;
    }
    case 'zoom': {
      const essay = store.peekEssay(state.currentId);
      return zoomImage(essay[el.dataset.srcKind][Number(el.dataset.index)]);
    }
    case 'ask': {
      if (window.matchMedia('(max-width: 1180px)').matches && !state.chatOpenMobile) setChatOpen(true);
      return sendChat(el.dataset.q);
    }
  }
});

$('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderSidebar(); });
window.addEventListener('hashchange', route);
// 離開頁面或切到別的分頁前，把還沒送出的修改送出去
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flushAll().catch(() => {}); });
window.addEventListener('pagehide', () => { store.flushAll().catch(() => {}); });

// ---------- 啟動 ----------
(async () => {
  if (!location.hash) history.replaceState(null, '', '#/zh');
  await ensureLogin();
  state.ready = true;
  route();
})();
