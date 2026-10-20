/* ============================================================
 * 整页翻译 · content.js
 *
 * 流程：收集文字节点 → 同一段落内的零碎行内片段并成整句 → 批量送后台翻译
 *       → 译好后按各片段长度比例分回原位，保留加粗/斜体/链接等格式
 * 原文全部留底，随时一键还原
 * ============================================================ */
(function () {
  'use strict';

  if (window.__ptInjected) return;
  window.__ptInjected = true;

  // Chromium 与 Firefox 都有 chrome.*（Firefox 提供回调版），优先用它；没有再退回 browser
  var API = (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome
    : (typeof browser !== 'undefined' && browser && browser.runtime ? browser : null);

  function send(msg) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var done = function (v) { if (!settled) { settled = true; resolve(v); } };
      var fail = function (e) { if (!settled) { settled = true; reject(e); } };

      var ret;
      try {
        ret = API.runtime.sendMessage(msg, function (res) {
          var err = API.runtime.lastError;
          if (err) fail(new Error(err.message)); else done(res);
        });
      } catch (e) { return fail(e); }

      if (ret && typeof ret.then === 'function') ret.then(done, fail);
    });
  }

  function broadcast(msg) {
    try {
      var p = send(msg);
      if (p && p.catch) p.catch(function () { });
    } catch (e) { /* 没有接收方无所谓 */ }
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------------- 不翻译的内容 ---------------- */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1,
    SVG: 1, CANVAS: 1, IFRAME: 1, MATH: 1, VIDEO: 1, AUDIO: 1
  };

  // 这些元素会把句子切断，两侧的文字不合并翻译
  var BARRIER_TAGS = {
    A: 1, BUTTON: 1, BR: 1, IMG: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1,
    SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, CODE: 1, PRE: 1,
    KBD: 1, SAMP: 1, VAR: 1, MATH: 1
  };

  var BLOCK_SELECTOR = 'p,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,td,th,caption,blockquote,figcaption,summary,label,button,div,section,article,aside,header,footer,main,nav,form,fieldset,legend,address,body';

  var LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  var CJK_CHAR = /[\u4E00-\u9FFF\u3400-\u4DBF]/;

  var MAX_ITEMS_PER_BATCH = 30;
  var MAX_CHARS_PER_BATCH = 4000;
  var MAX_UNIT_CHARS = 400;   // 合并后的单句上限

  var st = {
    phase: 'idle',      // idle | working | done
    records: [],        // 已替换的文字节点
    title: null,
    observer: null,
    timer: null,
    settings: null,
    target: null,
    targetLabel: '',
    done: 0,
    total: 0
  };

  /* ---------------- 按文档顺序收集文字节点 ---------------- */
  function skipElement(el) {
    var tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (SKIP_TAGS[tag]) return true;
    if (el.getAttribute) {
      if (el.getAttribute('translate') === 'no') return true;
      if (el.hasAttribute('data-pt-skip') || el.hasAttribute('data-pt-ui')) return true;
      var cls = el.getAttribute('class');
      if (cls && /(^|\s)(notranslate|no-translate)(\s|$)/.test(cls)) return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  // 返回 [{ node, block, seq, inb }]，按文档顺序
  // seq：遇到过多少个硬边界（链接/图片/换行等）；inb：自己是否在硬边界元素内部
  // 只有 block、seq、inb 全都相同的相邻片段才允许合并成一句
  function collectFrom(root, out) {
    if (!root) return out;
    var stack = [{ n: root, seq: 0, inb: false }];
    var seq = 0;

    while (stack.length) {
      var item = stack.pop();
      var node = item.n;

      if (node.nodeType === 3) {
        var t = node.nodeValue;
        if (t && t.trim().length > 0 && node.__ptState !== 'done' && LETTER.test(t)) {
          out.push({ node: node, block: blockOf(node), seq: item.seq, inb: item.inb });
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (skipElement(node)) continue;

      var tag = node.tagName ? String(node.tagName).toUpperCase() : '';
      var nextInb = item.inb;
      var nextSeq = item.seq;
      if (BARRIER_TAGS[tag]) {
        nextInb = true;
        if (!item.inb) nextSeq = ++seq;   // 在文档顺序上跨过一个硬边界
      }

      var kids = node.childNodes;
      for (var i = kids.length - 1; i >= 0; i--) {
        stack.push({ n: kids[i], seq: nextSeq, inb: nextInb });
      }
    }
    return out;
  }

  function blockOf(node) {
    var p = node.parentElement;
    if (!p) return null;
    var b = p.closest ? p.closest(BLOCK_SELECTOR) : null;
    return b || p;
  }

  /* ---------------- 合并成「翻译单元」 ---------------- */
  function buildUnits(items) {
    var units = [];
    var cur = null;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var text = it.node.nodeValue.trim();
      if (!text) continue;

      var joinable = cur &&
        cur.block === it.block &&
        cur.seq === it.seq &&
        cur.inb === it.inb &&
        (cur.chars + text.length + 1) <= MAX_UNIT_CHARS;

      if (joinable) {
        var prev = cur.text;
        var sep = /[\s(（\[【]$/.test(prev) || /^[.,;:!?)\]】%]/.test(text) ? '' : ' ';
        cur.text = prev + sep + text;
        cur.nodes.push(it.node);
        cur.chars += text.length + sep.length;
      } else {
        cur = { block: it.block, seq: it.seq, inb: it.inb, text: text, nodes: [it.node], chars: text.length };
        units.push(cur);
      }
    }
    return units;
  }

  /* ---------------- 判断页面是否已是目标语言 ---------------- */
  function looksLikeChinese(txt) {
    var sample = (txt || '').slice(0, 3000);
    // 出现假名/谚文就不是中文（避免误判日文、韩文页面）
    if ((sample.match(/[\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length > 5) return false;
    var cjk = (sample.match(CJK_CHAR) || []).length;
    var total = sample.replace(/\s/g, '').length;
    if (total < 20) return false;
    return cjk / total > 0.25;
  }

  /* ---------------- 写入 / 还原 ---------------- */
  function applyText(node, translated, allowEmpty) {
    if (typeof translated !== 'string') return;
    var body = translated.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    if (!body && !allowEmpty) return;

    var raw = node.nodeValue;
    var lead = (raw.match(/^\s*/) || [''])[0];
    var trail = (raw.match(/\s*$/) || [''])[0];

    if (node.__ptOriginal === undefined) {
      node.__ptOriginal = raw;
      st.records.push(node);
    }
    node.nodeValue = body ? lead + body + trail : '';
    node.__ptState = 'done';
  }

  // 把整句译文按原片段长度比例分回各个节点，保证拼起来就是完整一句
  function distribute(unit, translated) {
    var nodes = unit.nodes;
    var out = String(translated || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    if (!out) return;
    if (nodes.length === 1) {
      applyText(nodes[0], out);
      return;
    }

    var lens = [];
    var total = 0;
    for (var i = 0; i < nodes.length; i++) {
      var L = nodes[i].nodeValue.trim().length || 1;
      lens.push(L);
      total += L;
    }

    var pos = 0;
    for (var j = 0; j < nodes.length; j++) {
      var remain = out.length - pos;
      var share = (j === nodes.length - 1) ? remain : Math.round(out.length * lens[j] / total);
      share = Math.max(0, Math.min(share, remain));
      applyText(nodes[j], out.substr(pos, share), true);
      pos += share;
    }
  }

  function restoreAll(silent) {
    stopObserver();
    var n = 0;
    for (var i = 0; i < st.records.length; i++) {
      var node = st.records[i];
      if (node && node.__ptOriginal !== undefined && node.parentNode) {
        node.nodeValue = node.__ptOriginal;
        delete node.__ptOriginal;   // 清掉留底，下次翻译能重新记录
        node.__ptState = 'idle';
        n++;
      }
    }
    st.records = [];
    if (st.title !== null) {
      try { document.title = st.title; } catch (e) { /* 忽略 */ }
      st.title = null;
    }
    st.phase = 'idle';
    st.done = 0; st.total = 0;
    if (!silent) {
      hideToast(400);
      broadcast({ type: 'pt:progress', phase: 'restored', restored: n });
    }
    return n;
  }

  /* ---------------- 主流程 ---------------- */
  function buildBatches(units) {
    var batches = [], cur = [], len = 0;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var L = u.text.length;
      if (cur.length >= MAX_ITEMS_PER_BATCH || (len + L) > MAX_CHARS_PER_BATCH) {
        if (cur.length) batches.push(cur);
        cur = []; len = 0;
      }
      cur.push(u); len += L;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function runTranslation(items, opts) {
    opts = opts || {};
    var quiet = !!opts.quiet;

    var units = buildUnits(items);
    if (!units.length) return { ok: false, reason: 'empty' };

    st.phase = 'working';
    var batches = buildBatches(units);
    st.done = 0; st.total = batches.length;
    if (!quiet) showToast('翻译中…', 0);
    broadcast({ type: 'pt:progress', phase: 'start', total: batches.length });

    for (var b = 0; b < batches.length; b++) {
      var group = batches[b];
      var texts = group.map(function (u) { return u.text; });

      var res;
      try {
        res = await send({ type: 'pt:translate', texts: texts, target: st.target });
      } catch (e) {
        res = { ok: false, error: e && e.message };
      }

      if (!res || !res.ok) {
        st.phase = st.records.length ? 'done' : 'idle';
        var msg = (res && res.error) || '翻译失败';
        showToast('翻译失败：' + msg, 0, true);
        broadcast({ type: 'pt:progress', phase: 'error', error: msg });
        return { ok: false, error: msg };
      }

      for (var k = 0; k < group.length; k++) distribute(group[k], res.results[k]);
      st.done = b + 1;
      if (!quiet) showToast('翻译中 ' + st.done + '/' + st.total + '…', st.done / st.total);
      broadcast({ type: 'pt:progress', phase: 'batch', done: st.done, total: st.total });
      await sleep(40);
    }

    // 页面标题
    if ((!st.settings || st.settings.translateTitle) && st.title === null) {
      var rawTitle = document.title.trim();
      if (rawTitle && LETTER.test(rawTitle)) {
        try {
          var tr = await send({ type: 'pt:translate', texts: [rawTitle], target: st.target });
          if (tr && tr.ok && tr.results && tr.results[0]) {
            st.title = document.title;
            document.title = tr.results[0];
          }
        } catch (e) { /* 标题翻不了不影响正文 */ }
      }
    }

    st.phase = 'done';
    startObserver();
    if (!quiet) {
      showToast('已翻译 · 点击还原', 1, false, true);
      broadcast({ type: 'pt:progress', phase: 'done', total: st.total });
    }
    return { ok: true, count: st.records.length };
  }

  /* ---------------- 动态内容 ---------------- */
  function startObserver() {
    stopObserver();
    if (!document.body) return;
    st.observer = new MutationObserver(function (muts) {
      var added = [];
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type !== 'childList') continue;
        for (var j = 0; j < m.addedNodes.length; j++) {
          var a = m.addedNodes[j];
          if (a.nodeType === 1) {
            if (a.hasAttribute && (a.hasAttribute('data-pt-ui') || a.hasAttribute('data-pt-skip'))) continue;
            added.push(a);
          } else if (a.nodeType === 3 && a.parentNode && LETTER.test(a.nodeValue || '')) {
            added.push(a.parentNode);
          }
        }
      }
      if (!added.length) return;
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(function () { flushAdded(added); }, 600);
    });
    st.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (st.observer) { try { st.observer.disconnect(); } catch (e) { } st.observer = null; }
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  }

  var flushing = false;
  async function flushAdded(roots) {
    if (flushing || st.phase === 'working') return;
    flushing = true;
    try {
      var items = [];
      var seen = new Set();
      for (var i = 0; i < roots.length; i++) {
        var r = roots[i];
        if (!r || !r.isConnected) continue;
        var tmp = collectFrom(r, []);
        for (var j = 0; j < tmp.length; j++) {
          if (!seen.has(tmp[j].node)) { seen.add(tmp[j].node); items.push(tmp[j]); }
        }
      }
      if (items.length) await runTranslation(items, { quiet: true });
    } catch (e) { /* 动态内容失败不影响已翻部分 */ }
    finally { flushing = false; }
  }

  /* ---------------- 页面内提示条（Shadow DOM 隔离样式） ---------------- */
  var ui = null;

  function ensureUi() {
    if (ui && ui.host && ui.host.isConnected) return ui;
    var host = document.createElement('div');
    host.setAttribute('data-pt-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML =
      '<style>' +
      '.box{pointer-events:auto;display:flex;align-items:center;gap:9px;padding:9px 14px 9px 12px;' +
      'background:#fff;color:#111827;border:1px solid rgba(17,24,39,.10);border-radius:999px;' +
      'box-shadow:0 8px 28px rgba(17,24,39,.16),0 1px 3px rgba(17,24,39,.08);' +
      'font:400 13px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
      'opacity:0;transform:translateY(8px) scale(.97);transition:opacity .18s ease,transform .18s ease;cursor:default;max-width:70vw;}' +
      '.box.show{opacity:1;transform:none;}' +
      '.box.click{cursor:pointer;}' +
      '.dot{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid #e5e7eb;border-top-color:#2563eb;animation:sp .7s linear infinite;}' +
      '.box.ok .dot{border:none;background:#16a34a;animation:none;}' +
      '.box.err .dot{border:none;background:#dc2626;animation:none;}' +
      '.txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '@keyframes sp{to{transform:rotate(360deg)}}' +
      '</style>' +
      '<div class="box"><span class="dot"></span><span class="txt"></span></div>';
    (document.body || document.documentElement).appendChild(host);
    ui = { host: host, box: root.querySelector('.box'), txt: root.querySelector('.txt') };
    ui.box.addEventListener('click', function () {
      if (st.phase === 'done') restoreAll();
    });
    return ui;
  }

  function showToast(text, progress, isError, clickable) {
    var u = ensureUi();
    u.txt.textContent = text;
    var shown = u.box.classList.contains('show');
    u.box.className = 'box' + (isError ? ' err' : (progress >= 1 ? ' ok' : '')) +
      (clickable ? ' click' : '') + (shown ? ' show' : '');
    if (!shown) requestAnimationFrame(function () { u.box.classList.add('show'); });
    if (u.hideTimer) clearTimeout(u.hideTimer);
    if (progress >= 1 && !isError) {
      u.hideTimer = setTimeout(function () { hideToast(400); }, clickable ? 6000 : 1800);
    }
    if (isError) {
      u.hideTimer = setTimeout(function () { hideToast(400); }, 5000);
    }
  }

  function hideToast(delay) {
    var u = ui;
    if (!u) return;
    setTimeout(function () { if (u.box) u.box.classList.remove('show'); }, delay || 0);
  }

  /* ---------------- 对外消息 ---------------- */
  async function loadSettings() {
    try {
      var r = await send({ type: 'pt:settings' });
      if (r && r.ok) {
        st.settings = r.settings;
        st.target = r.settings.target;
        st.targetLabel = r.targetLabel || r.settings.target;
      }
    } catch (e) { /* 忽略 */ }
    if (!st.target) { st.target = 'zh-Hans'; st.targetLabel = '简体中文'; }
  }

  async function translatePage(force) {
    if (st.phase === 'working') return { ok: false, error: '正在翻译中，请稍候' };
    await loadSettings();

    if (!force && st.records.length === 0) {
      var isZhTarget = st.target.indexOf('zh') === 0;
      if (isZhTarget && looksLikeChinese(document.body ? document.body.innerText : '')) {
        showToast('这个页面看起来已经是中文了', 1);
        return { ok: false, reason: 'already' };
      }
    }

    var items = collectFrom(document.body, []);
    if (!items.length) {
      if (st.records.length) return { ok: true, count: st.records.length, cached: true };
      showToast('这一页没有可翻译的文字', 1);
      return { ok: false, reason: 'empty' };
    }
    return runTranslation(items, { quiet: false });
  }

  API.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;

    var snapshot = function () {
      return { phase: st.phase, translated: st.records.length > 0, count: st.records.length, done: st.done, total: st.total };
    };

    if (msg.type === 'pt:ping') {
      sendResponse({ ok: true, state: snapshot() });
      return true;
    }

    if (msg.type === 'pt:state') {
      sendResponse({ ok: true, state: snapshot() });
      return true;
    }

    if (msg.type === 'pt:translate') {
      translatePage(msg.force).then(
        function (r) { sendResponse(Object.assign({}, r, { state: snapshot() })); },
        function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      );
      return true;
    }

    if (msg.type === 'pt:restore') {
      var n = restoreAll();
      sendResponse({ ok: true, restored: n, state: snapshot() });
      return true;
    }

    if (msg.type === 'pt:toggle') {
      if (st.records.length) {
        restoreAll();
        sendResponse({ ok: true, action: 'restored' });
      } else {
        translatePage(false).then(
          function (r) { sendResponse(r); },
          function (e) { sendResponse({ ok: false, error: String(e) }); }
        );
      }
      return true;
    }
  });

  /* ---------------- 自动翻译 ---------------- */
  (async function autoRun() {
    try {
      await loadSettings();
      if (!st.settings || !st.settings.autoTranslate) return;
      if (st.target.indexOf('zh') === 0 && looksLikeChinese(document.body ? document.body.innerText : '')) return;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { translatePage(true); }, { once: true });
      } else {
        setTimeout(function () { translatePage(true); }, 300);
      }
    } catch (e) { /* 忽略 */ }
  })();
})();
