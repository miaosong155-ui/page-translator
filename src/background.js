/* ============================================================
 * 整页翻译 · background.js
 * 负责真正发起翻译请求（后台上下文不受页面 CORS / CSP 限制）
 * 兼容：Chrome MV3 service worker / Firefox MV2 background page
 * ============================================================ */

// MV3 service worker 需要手动引入 shared.js；MV2 已在 manifest 里声明
if (typeof importScripts === 'function') {
  try { importScripts('shared.js'); } catch (e) { console.error('[PT] importScripts 失败', e); }
}

const API = (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome
  : (typeof browser !== 'undefined' && browser && browser.runtime ? browser : null);

const CLIENT_KEY = 'browser-chrome-131.0.0-Windows_10';
const CACHE_LIMIT = 4000;
const memo = new Map(); // key: target|provider|text -> 译文

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    const res = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    try { return JSON.parse(text); } catch (e) { throw new Error('接口返回非 JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 引擎 1：腾讯交互翻译 ---------------- */
// 批量接口：一次最多可传数十条，返回顺序与入参一致，自动识别源语言
async function viaTencent(texts, lang) {
  const body = {
    header: { fn: 'auto_translation', client_key: CLIENT_KEY },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'auto', text_list: texts },
    target: { lang: lang.tencent }
  };
  const data = await fetchJSON('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const ret = data && data.header && data.header.ret_code;
  if (ret && ret !== 'succ') throw new Error('腾讯翻译错误：' + ret);
  const arr = data && data.auto_translation;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('腾讯翻译返回条数不匹配');
  return { results: arr.map(s => (typeof s === 'string' ? s : '')), src: data.src_lang || 'auto' };
}

/* ---------------- 引擎 2：MyMemory（兜底） ---------------- */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let buf = '';
  // 先按句末标点切，切不动再硬切
  const segs = text.split(/(?<=[.!?。！？;；])\s+/);
  for (const seg of segs) {
    if ((buf + seg).length > max) {
      if (buf) parts.push(buf.trim());
      buf = '';
      if (seg.length > max) {
        for (let i = 0; i < seg.length; i += max) parts.push(seg.slice(i, i + max));
        continue;
      }
    }
    buf = buf ? buf + ' ' + seg : seg;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text.slice(0, max)];
}

async function mmOne(text, src, tgt) {
  const chunks = splitLong(text, 450);
  const out = [];
  for (const chunk of chunks) {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) +
      '&langpair=' + encodeURIComponent(src) + '|' + encodeURIComponent(tgt);
    const d = await fetchJSON(url, {}, 20000);
    const t = d && d.responseData && d.responseData.translatedText;
    if (!t || String(t).toUpperCase().indexOf('QUERY LENGTH LIMIT') === 0) throw new Error('MyMemory 额度或长度受限');
    out.push(t);
    await sleep(80);
  }
  return out.join(' ');
}

async function viaMyMemory(texts, lang, srcHint) {
  const src = srcHint && srcHint !== 'auto' ? srcHint : 'en';
  const results = [];
  for (const t of texts) {
    results.push(await mmOne(t, src, lang.mymemory));
    await sleep(120);
  }
  return { results, src };
}

/* ---------------- 引擎 3：Google（可选） ---------------- */
async function viaGoogle(texts, lang) {
  const results = [];
  let src = 'auto';
  for (const t of texts) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(lang.google) + '&dt=t&q=' + encodeURIComponent(t);
    const d = await fetchJSON(url, {}, 20000);
    const seg = Array.isArray(d) && Array.isArray(d[0])
      ? d[0].map(x => (x && x[0]) ? x[0] : '').join('')
      : '';
    if (!seg) throw new Error('Google 翻译无返回');
    if (Array.isArray(d) && typeof d[2] === 'string') src = d[2];
    results.push(seg);
    await sleep(80);
  }
  return { results, src };
}

const ENGINES = { tencent: viaTencent, mymemory: viaMyMemory, google: viaGoogle };

/* ---------------- 调度：主引擎失败自动降级 ---------------- */
function cacheKey(target, provider, text) { return provider + '|' + target + '|' + text; }

function cacheGet(target, provider, text) {
  return memo.get(cacheKey(target, provider, text));
}
function cacheSet(target, provider, text, val) {
  if (memo.size >= CACHE_LIMIT) memo.delete(memo.keys().next().value);
  memo.set(cacheKey(target, provider, text), val);
}

async function translateTexts(texts, targetId, providerId) {
  const lang = PT.langById(targetId);
  if (!lang) throw new Error('不支持的目标语言：' + targetId);

  const results = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cacheGet(targetId, providerId || 'tencent', t);
    if (typeof hit === 'string') results[i] = hit;
    else todo.push(i);
  });

  let engineUsed = providerId || 'tencent';
  let src = 'auto';

  if (todo.length) {
    const chain = [];
    const push = (p) => { if (p && ENGINES[p] && chain.indexOf(p) < 0) chain.push(p); };
    push(providerId || 'tencent');
    push('tencent');
    push('mymemory');
    if (providerId === 'google') push('google');

    let lastErr = null;
    let ok = false;
    for (const id of chain) {
      try {
        const sub = todo.map(i => texts[i]);
        const r = await ENGINES[id](sub, lang, 'auto');
        sub.forEach((t, k) => {
          const v = r.results[k];
          results[todo[k]] = (typeof v === 'string' && v) ? v : t;
          cacheSet(targetId, providerId || 'tencent', t, results[todo[k]]);
        });
        engineUsed = id;
        src = r.src || 'auto';
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[PT] 引擎 ' + id + ' 失败：', e && e.message);
      }
    }
    if (!ok) throw lastErr || new Error('翻译失败');
  }

  return { results, provider: engineUsed, src };
}

/* ---------------- 消息路由 ---------------- */
async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'pt:ping':
      return { ok: true, version: '1.0.0' };

    case 'pt:settings': {
      const s = await PT.getSettings();
      const lang = PT.langById(s.target);
      return { ok: true, settings: s, targetLabel: lang ? lang.label : s.target };
    }

    case 'pt:translate': {
      if (!Array.isArray(msg.texts) || !msg.texts.length) return { ok: false, error: '没有需要翻译的内容' };
      const s = await PT.getSettings();
      const target = msg.target || s.target;
      const provider = msg.provider || s.provider;
      const r = await translateTexts(msg.texts, target, provider);
      return { ok: true, results: r.results, provider: r.provider, src: r.src, target };
    }

    default:
      return null; // 不是发给后台的消息（比如 content → popup 的进度广播）
  }
}

API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 进度广播之类的消息直接忽略，不要占住端口
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('pt:progress') === 0) return false;

  handle(msg, sender).then(
    (res) => { if (res !== null) sendResponse(res); },
    (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
  );
  return true;
});

/* ---------------- 快捷键：翻译 / 还原 ---------------- */
if (API.commands && API.commands.onCommand) {
  API.commands.onCommand.addListener(async (cmd) => {
    if (cmd !== 'toggle-translate') return;
    try {
      const tabs = await new Promise((resolve) => API.tabs.query({ active: true, currentWindow: true }, resolve));
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      API.tabs.sendMessage(tab.id, { type: 'pt:toggle' }, () => { void API.runtime.lastError; });
    } catch (e) { /* 忽略 */ }
  });
}

// 首次安装时给个明确的默认值
API.runtime.onInstalled.addListener(async () => {
  try {
    const s = await PT.getSettings();
    await PT.saveSettings(s);
  } catch (e) { /* 忽略 */ }
});
