/**
 * 冒烟测试：用 Edge（Chromium）无头模式真实加载 content.js，
 * 对着腾讯翻译接口跑一遍「翻译 → 校验 → 还原」。
 *
 * 用法：
 *   1) python -m http.server 8123 --directory test
 *   2) msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank
 *   3) node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = process.env.CDP_PORT || 9333;
const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8123/page.html';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error('连不上 DevTools，检查 Edge 是否已用 --remote-debugging-port 启动');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, reject) => this.pending.set(id, { resolve: res, reject }));
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const ver = await waitForDevtools();
  console.log('浏览器：', ver.Browser);

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: PAGE_URL });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true
    }, sessionId);
    if (r.exceptionDetails) throw new Error('页面内报错：' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  };

  await sleep(1200);

  // ---- 注入：chrome 运行时垫片（把消息路由到真实接口）+ content.js ----
  const contentSrc = readFileSync(resolve(ROOT, 'src/content.js'), 'utf8');

  const shim = `
  (function () {
    var listeners = [];
    window.__ptListeners = listeners;
    function route(msg) {
      if (msg.type === 'pt:settings') {
        return Promise.resolve({ ok: true, targetLabel: '简体中文',
          settings: { target: 'zh-Hans', provider: 'tencent', autoTranslate: false, translateTitle: true } });
      }
      if (msg.type === 'pt:translate') {
        var body = { header: { fn: 'auto_translation', client_key: 'browser-chrome-131.0.0-Windows_10' },
          type: 'plain', model_category: 'normal',
          source: { lang: 'auto', text_list: msg.texts }, target: { lang: 'zh' } };
        return fetch('https://transmart.qq.com/api/imt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.auto_translation) return { ok: false, error: '接口返回异常' };
          return { ok: true, results: d.auto_translation, provider: 'tencent' };
        }).catch(function (e) { return { ok: false, error: String(e) }; });
      }
      return Promise.resolve(null);
    }
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      lastError: null,
      sendMessage: function (msg, cb) { route(msg).then(function (r) { if (cb) cb(r); }); },
      onMessage: { addListener: function (fn) { listeners.push(fn); } }
    };
    window.__ptTrigger = function (msg) {
      return new Promise(function (resolve) {
        var handled = false;
        for (var i = 0; i < listeners.length; i++) {
          var ret = listeners[i](msg, {}, function (r) { handled = true; resolve(r); });
          if (ret === true) handled = true;
        }
        if (!handled) resolve(null);
      });
    };
  })();
  `;

  const before = await evaluate(`document.body.innerText`);

  await evaluate(shim);
  await evaluate(contentSrc);
  check('content.js 注入成功', await evaluate(`window.__ptInjected === true`));

  const t0 = Date.now();
  const translateRes = await evaluate(`window.__ptTrigger({ type: 'pt:translate' })`, true);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  check('整页翻译返回成功', !!(translateRes && translateRes.ok),
    translateRes ? `count=${translateRes.count} 耗时 ${elapsed}s` : '无返回');

  const after = await evaluate(`document.body.innerText`);

  // 断言 1：正文出现中文
  const cjkCount = (after.match(/[\u4E00-\u9FFF]/g) || []).length;
  check('译文出现中文', cjkCount > 60, `中文 ${cjkCount} 字`);

  // 断言 2：代码块没被翻译
  const codeText = await evaluate(`document.querySelector('pre code').textContent`);
  check('代码块保持原样', codeText.includes('const answer = items.map'), JSON.stringify(codeText.slice(0, 48)));

  // 断言 3：标题被翻译
  const title = await evaluate(`document.title`);
  check('网页标题被翻译', /[\u4E00-\u9FFF]/.test(title), title);

  // 断言 4：结构没被破坏
  const struct = await evaluate(`JSON.stringify({h1: document.querySelectorAll('h1').length, tr: document.querySelectorAll('tr').length, a: document.querySelectorAll('nav a').length, btn: document.querySelectorAll('button').length})`);
  const s = JSON.parse(struct);
  check('页面结构完整', s.h1 === 1 && s.tr === 3 && s.a === 3 && s.btn === 1, struct);

  // 断言 5：还原
  const restoreRes = await evaluate(`window.__ptTrigger({ type: 'pt:restore' })`);
  await sleep(300);
  const restored = await evaluate(`document.body.innerText`);
  const sameAsBefore = restored.replace(/\s+/g, ' ').trim() === before.replace(/\s+/g, ' ').trim();
  check('还原后与原文完全一致', sameAsBefore, restoreRes ? `restored=${restoreRes.restored}` : '');

  // 断言 6：再翻一次（验证留底被正确清理）
  const again = await evaluate(`window.__ptTrigger({ type: 'pt:translate' })`);
  check('可以重复翻译', !!(again && again.ok), again ? `count=${again.count}` : '');

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 项失败` : `结果：全部 ${results.length} 项通过`);

  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e.message);
  process.exit(2);
});
