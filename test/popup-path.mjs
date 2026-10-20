/**
 * 弹窗路径测试：在扩展弹窗的上下文里，走一遍用户点「翻译此页」时真正调用的那几个函数
 *   PT.queryTabs → PT.injectContent（兜底注入）→ PT.sendTab（pt:translate）→ PT.sendTab（pt:restore）
 * 这条路径正是之前报 "browser.tabs.executeScript is not a function" 的地方。
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
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
const cdp = new CDP(ws);

// 打开测试页（会唤醒 service worker）
await cdp.send('Target.createTarget', { url: PAGE_URL });

let swTarget = null;
for (let i = 0; i < 25 && !swTarget; i++) {
  await sleep(400);
  const { targetInfos } = await cdp.send('Target.getTargets');
  swTarget = targetInfos.find((t) => t.url.includes('background.js'));
}
if (!swTarget) { console.log('FAIL  扩展未加载'); process.exit(1); }
const extId = swTarget.url.split('/')[2];

// 打开弹窗页面
const pop = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pop.targetId, flatten: true });
await cdp.send('Runtime.enable', {}, sessionId);
await sleep(1200);

const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(d);
  }
  return r.result.value;
};

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

check('PT 在此浏览器被正确识别为非 Firefox', (await evaluate(`PT.isFirefox`)) === false,
  `UA 判定=${await evaluate(`PT.isFirefox`)}`);

const tabInfo = JSON.parse(await evaluate(`
  (async function () {
    var tabs = await PT.queryTabs({});
    var out = { total: tabs.length, hit: null };
    for (var i = 0; i < tabs.length; i++) {
      try {
        var r = await PT.sendTab(tabs[i].id, { type: 'pt:ping' });
        if (r && r.ok) { out.hit = tabs[i].id; break; }
      } catch (e) { /* 这个标签页没有 content script */ }
    }
    return JSON.stringify(out);
  })()
`));
check('PT.queryTabs 可用并能定位测试页', !!tabInfo.hit,
  tabInfo ? `共 ${tabInfo.total} 个标签页，命中 id=${tabInfo.hit}` : '无结果');

if (tabInfo && tabInfo.hit) {
  const tabId = tabInfo.hit;
  // 1) 兜底注入：这里以前会抛 "browser.tabs.executeScript is not a function"
  let injected = null;
  try {
    injected = await evaluate(`PT.injectContent(${tabId}).then(function (how) { return how; })`);
  } catch (e) {
    injected = 'ERROR: ' + e.message;
  }
  check('PT.injectContent 走通（MV3 scripting 分支）', injected === 'scripting', String(injected));

  // 2) 翻译
  const t0 = Date.now();
  const tr = JSON.parse(await evaluate(`PT.sendTab(${tabId}, { type: 'pt:translate' }).then(function (r) { return JSON.stringify(r); })`));
  check('PT.sendTab 翻译成功', !!tr.ok, tr.ok ? `count=${tr.count} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : JSON.stringify(tr));

  // 3) 状态与还原
  const st = JSON.parse(await evaluate(`PT.sendTab(${tabId}, { type: 'pt:state' }).then(function (r) { return JSON.stringify(r.state); })`));
  check('pt:state 报告已翻译', st.translated === true, JSON.stringify(st));

  const rs = JSON.parse(await evaluate(`PT.sendTab(${tabId}, { type: 'pt:restore' }).then(function (r) { return JSON.stringify(r); })`));
  check('pt:restore 还原成功', rs.ok === true, `restored=${rs.restored}`);
}

console.log('');
const failed = results.filter((x) => !x).length;
console.log(failed ? `结果：${results.length - failed}/${results.length} 通过` : `结果：全部 ${results.length} 项通过`);
ws.close();
process.exit(failed ? 1 : 0);
