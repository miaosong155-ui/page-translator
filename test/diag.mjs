/**
 * 诊断：在扩展弹窗的上下文里，看各家 API 到底长什么样。
 */
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
}

const ver = await (await fetch(`${BASE}/json/version`)).json();
console.log('UA:', ver['User-Agent']);
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
const cdp = new CDP(ws);

// 找一个已加载的扩展
let { targetInfos } = await cdp.send('Target.getTargets');
let sw = targetInfos.find((t) => t.url.includes('background.js'));
if (!sw) {
  // 唤醒：开一个普通扩展页面不行，先看有没有扩展页面
  console.log('没有 service worker 目标，现有目标：');
  console.log(targetInfos.map((t) => `  ${t.type} ${t.url}`).join('\n'));
  process.exit(1);
}
const extId = sw.url.split('/')[2];

const pop = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pop.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);
await sleep(1200);

const probe = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasBrowser: typeof browser,
    hasChrome: typeof chrome,
    browserKeys: typeof browser === 'object' && browser ? Object.keys(browser).slice(0, 12) : null,
    isFirefoxFlag: window.PT ? window.PT.isFirefox : 'no PT',
    hasChromeScripting: !!(window.chrome && chrome.scripting && chrome.scripting.executeScript),
    hasChromeTabsExecuteScript: !!(window.chrome && chrome.tabs && chrome.tabs.executeScript),
    hasBrowserTabsExecuteScript: !!(typeof browser === 'object' && browser && browser.tabs && browser.tabs.executeScript),
    hasBrowserScripting: !!(typeof browser === 'object' && browser && browser.scripting),
    hasGetBrowserInfo: !!(typeof browser === 'object' && browser && browser.runtime && browser.runtime.getBrowserInfo),
    chromeGetBrowserInfo: !!(window.chrome && chrome.runtime && chrome.runtime.getBrowserInfo),
    sendMessageReturns: (function(){ try { var r = chrome.runtime.sendMessage({type:'pt:ping'}); return typeof r; } catch(e) { return 'throw:'+e.message; } })()
  })`,
  returnByValue: true, awaitPromise: false
}, sessionId);
console.log(pretty(probe.result.value));
ws.close();

function pretty(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }
