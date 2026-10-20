/**
 * 真实扩展链路测试：不使用任何垫片，
 * 由扩展自己的 service worker 通过 chrome.tabs.sendMessage 驱动页面翻译。
 * 需要已用 --load-extension=dist/chrome 启动浏览器，并且本地 8123 有测试页。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CDP_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8123/page.html';
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
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const cdp = new CDP(ws);

const { targetInfos: initialTargets } = await cdp.send('Target.getTargets');

// 先打开测试页：content script 加载时会跟后台通信，能把休眠的 service worker 唤醒
const page = await cdp.send('Target.createTarget', { url: PAGE_URL });

let swTarget = null;
for (let i = 0; i < 25; i++) {
  await sleep(400);
  const { targetInfos } = await cdp.send('Target.getTargets');
  swTarget = targetInfos.find((t) => t.url.includes('background.js'));
  if (swTarget) break;
}
if (!swTarget) {
  console.log('FAIL  扩展未加载（没有 background.js 目标）');
  console.log('现有目标：', initialTargets.map((t) => `${t.type}:${t.url}`).join('\n  '));
  process.exit(1);
}
await sleep(1200);

const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
const pageSession = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSession);
await cdp.send('Runtime.enable', {}, pageSession);

const swEval = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, swSession);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const pageEval = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// 让 service worker 给所有标签页广播指令，收集有 content script 的回应
const driveAll = (msg) => swEval(`
  new Promise(function (resolve) {
    chrome.tabs.query({}, function (tabs) {
      var out = [];
      var left = tabs.length;
      if (!left) return resolve(JSON.stringify([]));
      tabs.forEach(function (t) {
        chrome.tabs.sendMessage(t.id, ${JSON.stringify(msg)}, function (r) {
          if (!chrome.runtime.lastError && r) out.push(r);
          if (--left === 0) resolve(JSON.stringify(out));
        });
      });
    });
  })
`);

const ping = JSON.parse(await driveAll({ type: 'pt:ping' }));
check('页面已注入 content script', ping.length > 0, `响应 ${ping.length} 个`);

const t0 = Date.now();
const res = JSON.parse(await driveAll({ type: 'pt:translate' }));
const okRes = res.find((r) => r && r.ok);
check('后台真实翻译成功', !!okRes, okRes ? `count=${okRes.count} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : JSON.stringify(res));

await sleep(400);
const text = await pageEval(`document.body.innerText`);
const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
check('页面出现中文译文', cjk > 60, `${cjk} 字`);
check('代码块未被翻译', (await pageEval(`document.querySelector('pre code').textContent`)).includes('const answer'));

// 截图存档
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1200, deviceScaleFactor: 1, mobile: false }, pageSession);
await sleep(300);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, pageSession);
const fs = await import('node:fs');
fs.writeFileSync(resolve(__dirname, 'translated.png'), Buffer.from(shot.data, 'base64'));
console.log('      截图：test/translated.png');

const restored = JSON.parse(await driveAll({ type: 'pt:restore' }));
check('还原指令生效', restored.some((r) => r && r.ok), JSON.stringify(restored.slice(0, 2)));
await sleep(300);
const back = await pageEval(`document.querySelector('h1').textContent`);
check('标题恢复英文', /A Short Guide/.test(back), back);

console.log('');
const failed = results.filter((x) => !x).length;
console.log(failed ? `结果：${results.length - failed}/${results.length} 通过` : `结果：全部 ${results.length} 项通过`);
ws.close();
process.exit(failed ? 1 : 0);
