/**
 * 验证扩展能否被 Chromium 正常加载（manifest / service worker / 弹窗渲染）。
 * 用法：node test/check-ext.mjs
 * 需要浏览器以 --load-extension=dist/chrome 启动并开启 --remote-debugging-port
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
console.log('浏览器：', ver.Browser);

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

const { targetInfos } = await cdp.send('Target.getTargets');
const sw = targetInfos.find((t) => t.url.includes('background.js'));
if (!sw) {
  console.log('FAIL  没有找到扩展的 service worker，扩展可能没被加载');
  console.log('现有 target：', targetInfos.map((t) => `${t.type}:${t.url}`).join('\n  '));
  process.exit(1);
}
const extId = sw.url.split('/')[2];
console.log('PASS  扩展已加载，service worker 运行中');
console.log('      扩展 ID：', extId);

// 打开弹窗页面并截图（先让测试页成为「当前标签页」，还原真实使用场景）
const pageUrl = process.env.PAGE_URL || 'http://127.0.0.1:8123/page.html';
const pageTarget = await cdp.send('Target.createTarget', { url: pageUrl });
await sleep(1200);

const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 320, height: 430, deviceScaleFactor: 2, mobile: false
}, sessionId);

// 把测试页设为前台，再刷新弹窗页面，模拟「在普通网页上点开扩展图标」
await cdp.send('Target.activateTarget', { targetId: pageTarget.targetId });
await cdp.send('Page.reload', {}, sessionId);
await sleep(1600);

const probe = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasPT: typeof window.PT === 'object',
    langs: document.querySelectorAll('#target option').length,
    providers: document.querySelectorAll('#provider option').length,
    target: document.querySelector('#target').value,
    provider: document.querySelector('#provider').value,
    title: document.querySelector('h1') ? document.querySelector('h1').textContent : null
  })`,
  returnByValue: true
}, sessionId);
console.log('PASS  弹窗已渲染：', probe.result.value);

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
const out = resolve(__dirname, 'popup.png');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('      截图：', out);

ws.close();
process.exit(0);
