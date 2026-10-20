/* ============================================================
 * 整页翻译 · popup.js
 * ============================================================ */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const RT = PT.api.runtime;

  let tab = null;
  let busy = false;

  /* ---------- 小工具 ---------- */
  function queryTab() {
    return PT.queryTabs({ active: true, currentWindow: true });
  }

  function notice(text, kind) {
    // kind: 'info' | 'ok' | 'err'（兼容布尔写法）
    if (kind === true) kind = 'err';
    if (!kind || kind === false) kind = 'info';
    const el = $('#notice');
    el.textContent = text;
    el.classList.remove('ok', 'err');
    if (kind === 'ok') el.classList.add('ok');
    else if (kind === 'err') el.classList.add('err');
    el.hidden = false;
  }

  function hideNotice() { $('#notice').hidden = true; }

  function showProgress(pct, text) {
    $('#progress').hidden = false;
    $('#bar').style.width = Math.round(Math.max(0, Math.min(1, pct)) * 100) + '%';
    $('#progress-txt').textContent = text;
  }

  function hideProgress() { $('#progress').hidden = true; }

  function setBusy(v) {
    busy = v;
    $('#btn-translate').disabled = v;
    $('#btn-translate').querySelector('.btn-txt').textContent = v ? '翻译中…' : '翻译此页';
    $('#target').disabled = v;
    $('#provider').disabled = v;
  }

  function applyState(state) {
    const translated = !!(state && state.translated);
    $('#btn-restore').disabled = !translated;
    if (!busy) {
      $('#btn-translate').querySelector('.btn-txt').textContent = translated ? '重新检查并补翻' : '翻译此页';
    }
    $('#subtitle').textContent = translated
      ? '本页已翻译 · 可随时还原原文'
      : '把当前网页整页译成你指定的语言';
  }

  /* ---------- 注入兜底：扩展刚装好时，旧标签页里还没有 content script ---------- */
  async function ensureContent(tabId) {
    try {
      const r = await PT.sendTab(tabId, { type: 'pt:ping' });
      if (r && r.ok) return;
    } catch (e) { /* 没有就注入 */ }

    // 正常情况下点图标会拿到 activeTab 授权，tab.url 是可读的；
    // 万一读不到也不要误判，直接尝试注入，让真实报错暴露出来
    const url = (tab && tab.url) || '';
    if (url && !/^(https?|file):/i.test(url)) {
      throw new Error('浏览器内置页面（设置页、扩展商店、PDF 阅读器等）不允许注入脚本，请换普通网页试试。');
    }

    try {
      await PT.injectContent(tabId);
    } catch (e) {
      throw new Error('无法在这个页面运行脚本：' + ((e && e.message) || '注入失败') +
        '（浏览器内置页面、扩展商店、PDF 阅读器不支持翻译）');
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    PT.LANGS.forEach((l) => $('#target').append(new Option(l.label, l.id)));
    PT.PROVIDERS.forEach((p) => $('#provider').append(new Option(p.label, p.id)));

    const s = await PT.getSettings();
    $('#target').value = s.target;
    $('#provider').value = s.provider;
    $('#auto').checked = !!s.autoTranslate;

    const tabs = await queryTab();
    tab = tabs && tabs[0];

    if (!tab || !tab.id) {
      notice('没有拿到当前标签页，请重新打开扩展。', true);
      setBusy(true);
      return;
    }

    try {
      await ensureContent(tab.id);
      const r = await PT.sendTab(tab.id, { type: 'pt:state' });
      applyState(r && r.state);
    } catch (e) {
      applyState(null);
      notice('这个页面暂时无法翻译：' + (e && e.message ? e.message : '未知原因'), true);
    }
  }

  /* ---------- 事件 ---------- */
  $('#target').addEventListener('change', (e) => {
    PT.saveSettings({ target: e.target.value });
    hideNotice();
  });

  $('#provider').addEventListener('change', (e) => {
    PT.saveSettings({ provider: e.target.value });
    hideNotice();
  });

  $('#auto').addEventListener('change', (e) => {
    PT.saveSettings({ autoTranslate: e.target.checked });
  });

  $('#btn-translate').addEventListener('click', async () => {
    if (!tab || busy) return;
    hideNotice();
    setBusy(true);
    showProgress(0, '正在准备…');
    try {
      await ensureContent(tab.id);
      const r = await PT.sendTab(tab.id, { type: 'pt:translate' });
      if (r && r.ok) {
        hideProgress();
        applyState(r.state || { translated: true });
        notice('已翻译 ' + (r.count || 0) + ' 处文字。', 'ok');
      } else if (r && r.reason === 'already') {
        hideProgress();
        notice('这个页面看起来已经是目标语言了，无需翻译。', 'info');
      } else if (r && r.reason === 'empty') {
        hideProgress();
        notice('这一页没有找到可翻译的文字。', 'info');
      } else {
        hideProgress();
        notice((r && r.error) || '翻译失败，请稍后重试。', 'err');
      }
    } catch (e) {
      hideProgress();
      notice(e && e.message ? e.message : '翻译失败，请稍后重试。', true);
    } finally {
      setBusy(false);
    }
  });

  $('#btn-restore').addEventListener('click', async () => {
    if (!tab || busy) return;
    try {
      const r = await PT.sendTab(tab.id, { type: 'pt:restore' });
      applyState({ translated: false });
      hideNotice();
      notice('已还原为原文。', false);
    } catch (e) {
      notice('还原失败：' + (e && e.message ? e.message : '未知原因'), true);
    }
  });

  // 接收页面里的进度广播
  RT.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'pt:progress') return;
    if (msg.phase === 'start') showProgress(0, '共 ' + msg.total + ' 批内容，开始翻译…');
    else if (msg.phase === 'batch') showProgress(msg.done / msg.total, '已翻译 ' + msg.done + '/' + msg.total + ' 批');
    else if (msg.phase === 'done') { hideProgress(); applyState({ translated: true }); }
    else if (msg.phase === 'error') { hideProgress(); notice(msg.error || '翻译失败', true); }
  });

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
