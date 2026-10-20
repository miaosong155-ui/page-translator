/* ============================================================
 * 整页翻译 · shared.js
 * 语言表、常量、跨浏览器 API 封装
 * 被 popup.html 与 background 共同引用
 *
 * 注意：Chromium（Chrome/Edge）也会暴露 window.browser，
 * 所以不能用「有没有 browser 对象」判断浏览器类型，
 * 一律按「某个 API 是否存在」来选实现。
 * ============================================================ */
(function (root) {
  'use strict';

  // ---------- 语言表 ----------
  const LANGS = [
    { id: 'zh-Hans', label: '简体中文', tencent: 'zh', google: 'zh-CN', mymemory: 'zh-CN' },
    { id: 'zh-Hant', label: '繁體中文', tencent: 'zh-TW', google: 'zh-TW', mymemory: 'zh-TW' },
    { id: 'en', label: 'English', tencent: 'en', google: 'en', mymemory: 'en' },
    { id: 'ja', label: '日本語', tencent: 'ja', google: 'ja', mymemory: 'ja-JP' },
    { id: 'ko', label: '한국어', tencent: 'ko', google: 'ko', mymemory: 'ko-KR' },
    { id: 'fr', label: 'Français', tencent: 'fr', google: 'fr', mymemory: 'fr-FR' },
    { id: 'de', label: 'Deutsch', tencent: 'de', google: 'de', mymemory: 'de-DE' },
    { id: 'es', label: 'Español', tencent: 'es', google: 'es', mymemory: 'es-ES' },
    { id: 'ru', label: 'Русский', tencent: 'ru', google: 'ru', mymemory: 'ru-RU' },
    { id: 'pt', label: 'Português', tencent: 'pt', google: 'pt', mymemory: 'pt-PT' },
    { id: 'it', label: 'Italiano', tencent: 'it', google: 'it', mymemory: 'it-IT' },
    { id: 'ar', label: 'العربية', tencent: 'ar', google: 'ar', mymemory: 'ar-SA' }
  ];

  const PROVIDERS = [
    { id: 'tencent', label: '腾讯翻译（推荐 · 国内直连）' },
    { id: 'mymemory', label: 'MyMemory（备用 · 有额度限制）' },
    { id: 'google', label: 'Google（需能访问外网）' }
  ];

  const DEFAULTS = {
    target: 'zh-Hans',
    provider: 'tencent',
    autoTranslate: false,
    translateTitle: true
  };

  // ---------- 命名空间 ----------
  // 扩展上下文里 chrome.* 一定存在（Firefox 也提供回调版 chrome.*），优先用它
  const API = (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome
    : (typeof browser !== 'undefined' && browser && browser.runtime ? browser : null);

  function lastError() {
    try { return (API && API.runtime) ? API.runtime.lastError : null; } catch (e) { return null; }
  }

  /**
   * 统一调用：同时兼容「回调式」和「Promise 式」两套 API。
   * 传入回调，若返回 Promise 也一并接管，先到者生效。
   */
  function call(fn, ctx, args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      let ret;
      try {
        ret = fn.apply(ctx, args.concat([(res) => {
          const err = lastError();
          if (err) fail(new Error(err.message));
          else done(res);
        }]));
      } catch (e) {
        return fail(e);
      }

      if (ret && typeof ret.then === 'function') ret.then(done, fail);
    });
  }

  // 发给 background
  const sendMessage = (msg) => call(API.runtime.sendMessage, API.runtime, [msg]);
  // 发给某个标签页里的 content script
  const sendTab = (tabId, msg) => call(API.tabs.sendMessage, API.tabs, [tabId, msg]);
  const queryTabs = (q) => call(API.tabs.query, API.tabs, [q || {}]);

  // ---------- 设置读写（storage.local） ----------
  const storageGet = (keys) => call(API.storage.local.get, API.storage.local, [keys]);
  const storageSet = (obj) => call(API.storage.local.set, API.storage.local, [obj]);

  async function getSettings() {
    const raw = await storageGet(Object.keys(DEFAULTS));
    const s = Object.assign({}, DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (raw && raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
    }
    if (!langById(s.target)) s.target = DEFAULTS.target;
    if (!PROVIDERS.some(p => p.id === s.provider)) s.provider = DEFAULTS.provider;
    return s;
  }

  function saveSettings(patch) {
    return storageSet(patch);
  }

  function langById(id) {
    return LANGS.find(l => l.id === id) || null;
  }

  /**
   * 注入 content script（旧标签页里还没有 content script 时用）
   * 优先 scripting.executeScript（MV3），退回 tabs.executeScript（MV2）
   */
  async function injectContent(tabId) {
    const file = 'content.js';

    if (API.scripting && typeof API.scripting.executeScript === 'function') {
      await call(API.scripting.executeScript, API.scripting, [{ target: { tabId }, files: [file] }]);
      return 'scripting';
    }
    if (API.tabs && typeof API.tabs.executeScript === 'function') {
      await call(API.tabs.executeScript, API.tabs, [tabId, { file: file }]);
      return 'tabs.executeScript';
    }
    throw new Error('这个浏览器的扩展 API 不支持脚本注入');
  }

  const isFirefox = /firefox/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');

  root.PT = {
    LANGS, PROVIDERS, DEFAULTS,
    api: API,
    langById, getSettings, saveSettings,
    sendMessage, sendTab, queryTabs,
    storageGet, storageSet,
    injectContent, isFirefox
  };
})(typeof self !== 'undefined' ? self : this);
