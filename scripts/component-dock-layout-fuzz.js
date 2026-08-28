// 组件坞布局求解器模糊回归：驱动真实 resolveDockLayout，随机生成 600+ 场景，
// 硬断言：①任何结果绝不重叠；②焦点组件位置与用户请求一致（不被算法搬走）；
// ③八方向缩放的锚定边（被按住的边）纹丝不动。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = Number(process.argv[2] || 9578);
const outputDir = path.join(appDir, '.widgetly-crash-test', `dock-fuzz-${Date.now()}`);
const profileDir = path.join(outputDir, 'profile');
const dockId = 'component-dock-fuzz';
const childIds = ['fuzz-a', 'fuzz-b', 'fuzz-c', 'fuzz-d', 'fuzz-e', 'fuzz-f'];
const widgetIds = ['digitalClockGlass', 'miniCalendarGlass', 'lineWeather', 'stickyNote', 'analogClock', 'desktopFolder'];
const INITIAL = [
  { x: 0, y: 0, w: .30, h: .24 }, { x: .32, y: 0, w: .32, h: .24 }, { x: .66, y: 0, w: .32, h: .24 },
  { x: 0, y: .26, w: .30, h: .24 }, { x: .32, y: .26, w: .32, h: .24 }, { x: .66, y: .26, w: .32, h: .24 },
];
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false, openManagerOnStart: false, closeToTray: true, pinToDesktop: false,
  instances: [
    { id: dockId, widgetId: 'componentDock', x: 60, y: 60, config: {
      layout: 'free', children: childIds.map((id, index) => ({ instanceId: id, slotId: `slot-${id}`, surface: 'inherit', rect: { ...INITIAL[index] }, manual: false })),
    } },
    ...childIds.map((id, index) => ({ id, widgetId: widgetIds[index], x: 0, y: 0, host: { type: 'componentDock', dockId }, config: {} })),
  ],
}, null, 2));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) { this.next = 1; this.pending = new Map(); this.socket = new WebSocket(url); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); this.socket.addEventListener('message', (event) => { const data = JSON.parse(event.data); const pending = this.pending.get(data.id); if (!pending) return; this.pending.delete(data.id); data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result); }); }
  async send(method, params = {}) { await this.ready; return new Promise((resolve, reject) => { const id = this.next++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed'); return result.result.value; }
  close() { try { this.socket.close(); } catch (_) {} }
}
async function pages() { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((item) => item.type === 'page'); }
async function waitFor(match, timeout = 25_000) { const started = Date.now(); while (Date.now() - started < timeout) { try { const found = (await pages()).find(match); if (found) return found; } catch (_) {} await wait(90); } throw new Error('Target timeout'); }

const rnd = (min, max) => min + Math.random() * (max - min);
const overlaps = (a, b, eps = .012) => a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function buildScenarios() {
  const scenarios = [];
  // —— 移动：随机位置/尺寸（恒在边界内，保证不被钳制 → 焦点必须与请求完全一致）——
  for (let i = 0; i < 220; i += 1) {
    const id = childIds[Math.floor(Math.random() * childIds.length)];
    scenarios.push({ dockId, focusId: id, rect: { x: rnd(.01, .55), y: rnd(.01, .55), w: rnd(.22, .45), h: rnd(.20, .38) }, intent: 'move' });
  }
  // —— 八方向缩放：锚定边断言 ——
  const edges = ['e', 'w', 's', 'n', 'ne', 'se', 'sw', 'nw'];
  for (let i = 0; i < 320; i += 1) {
    const id = childIds[Math.floor(Math.random() * childIds.length)];
    const edge = edges[Math.floor(Math.random() * edges.length)];
    const base = { ...INITIAL[childIds.indexOf(id)] };
    const d = rnd(-.04, .22);
    const rect = { ...base };
    if (edge.includes('e')) rect.w = clamp(base.w + d, .2, .6);
    if (edge.includes('w')) { rect.w = clamp(base.w - d, .2, .6); rect.x = clamp(base.x + d, .01, .9); }
    if (edge.includes('s')) rect.h = clamp(base.h + d, .2, .5);
    if (edge.includes('n')) { rect.h = clamp(base.h - d, .2, .5); rect.y = clamp(base.y + d, .01, .9); }
    scenarios.push({ dockId, focusId: id, rect, intent: `resize-${edge}` });
  }
  // —— 拖入新组件（虚拟焦点）——
  for (let i = 0; i < 120; i += 1) {
    scenarios.push({ dockId, focusId: `virtual-${i}`, virtualWidgetId: widgetIds[Math.floor(Math.random() * widgetIds.length)], rect: { x: rnd(.01, .5), y: rnd(.01, .5), w: rnd(.22, .45), h: rnd(.20, .38) }, intent: 'external-drop' });
  }
  // —— 连续拖拽路径：同一组件按 16px 步进横穿组件坞 ——
  const pathId = childIds[2];
  for (let step = 0; step < 26; step += 1) {
    scenarios.push({ dockId, focusId: pathId, rect: { x: .02 + step * .033, y: .30, w: .30, h: .24 }, intent: 'move' });
  }
  return scenarios;
}

function expectedClamp(r, initial, intent, min) {
  const minW = (min && min.w) || .12, minH = (min && min.h) || .10;
  const w = Math.max(minW, Math.min(1, r.w));
  const h = Math.max(minH, Math.min(1, r.h));
  if (intent === 'move' || intent === 'external-drop') {
    return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
  }
  const edge = intent.slice('resize-'.length);
  const a = { e: edge.includes('e'), w: edge.includes('w'), n: edge.includes('n'), s: edge.includes('s') };
  const rightEdge = initial.x + initial.w, bottomEdge = initial.y + initial.h;
  let x = r.x, y = r.y, ww = w, hh = h;
  if (a.e) { x = initial.x; ww = Math.min(w, 1 - x); }
  if (a.w) { ww = Math.min(w, rightEdge); x = rightEdge - ww; }
  if (a.s) { y = initial.y; hh = Math.min(h, 1 - y); }
  if (a.n) { hh = Math.min(h, bottomEdge); y = bottomEdge - hh; }
  if (!a.e && !a.w) x = clamp(x, 0, 1 - ww);
  if (!a.s && !a.n) y = clamp(y, 0, 1 - hh);
  return { x, y, w: ww, h: hh };
}

function assertScenario(scenario, result, failures) {
  if (result.error) { failures.push(`场景 ${JSON.stringify(scenario)} 求解报错: ${result.error}`); return; }
  const layouts = result.layouts || [];
  const focus = result.focus;
  // 1) 绝不重叠
  for (let i = 0; i < layouts.length; i += 1) {
    for (let j = i + 1; j < layouts.length; j += 1) {
      if (overlaps(layouts[i].rect, layouts[j].rect)) failures.push(`重叠: ${layouts[i].id} vs ${layouts[j].id} @ ${JSON.stringify(scenario.rect)}`);
    }
  }
  if (!focus) return;
  // 2) 焦点 id 必须就是请求的组件
  const isVirtual = scenario.focusId.startsWith('virtual-');
  if (!isVirtual && focus.id !== scenario.focusId) failures.push(`焦点错位: 请求 ${scenario.focusId} 得到 ${focus.id}`);
  if (isVirtual && !focus.id.startsWith('virtual-')) failures.push(`虚拟焦点缺失: ${scenario.focusId}`);
  const r = scenario.rect;
  const initial = INITIAL[childIds.indexOf(scenario.focusId)] || null;
  const expected = expectedClamp(r, initial || { x: 0, y: 0, w: 0, h: 0 }, scenario.intent, result.min);
  const F = focus.rect;
  const close = (a, b) => Math.abs(a - b) <= 1e-9;
  if (scenario.intent === 'move' || scenario.intent === 'external-drop') {
    // 焦点必须与“请求经最小尺寸钳制后的值”完全一致（不被算法搬走/改尺寸）
    if (!close(F.x, expected.x) || !close(F.y, expected.y) || !close(F.w, expected.w) || !close(F.h, expected.h)) {
      failures.push(`焦点被改: ${JSON.stringify(scenario)} → ${JSON.stringify(F)} 期望 ${JSON.stringify(expected)}`);
    }
  } else if (initial) {
    const edge = scenario.intent.slice('resize-'.length);
    if (edge.includes('e') && !close(F.x, initial.x)) failures.push(`锚定左缘失败(e): ${scenario.intent} F.x=${F.x} 期望 ${initial.x}`);
    if (edge.includes('w') && !close(F.x + F.w, initial.x + initial.w)) failures.push(`锚定右缘失败(w): ${scenario.intent} right=${F.x + F.w} 期望 ${initial.x + initial.w}`);
    if (edge.includes('s') && !close(F.y, initial.y)) failures.push(`锚定上缘失败(s): ${scenario.intent} F.y=${F.y} 期望 ${initial.y}`);
    if (edge.includes('n') && !close(F.y + F.h, initial.y + initial.h)) failures.push(`锚定下缘失败(n): ${scenario.intent} bottom=${F.y + F.h} 期望 ${initial.y + initial.h}`);
    if (F.w < .01 || F.h < .01) failures.push(`焦点尺寸异常: ${JSON.stringify(F)}`);
  }
}

(async () => {
  let child = null; let dock = null;
  try {
    child = spawn(electronExe, [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--widgetly-test-mode'], { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const target = await waitFor((page) => { try { return new URL(page.url).pathname.endsWith('/widgets/componentDock/index.html'); } catch (_) { return false; } });
    dock = new Cdp(target.webSocketDebuggerUrl); await dock.ready;
    await wait(600);
    const scenarios = buildScenarios();
    const failures = [];
    // 分批调用，避免单次 IPC 过大
    const batchSize = 60;
    for (let i = 0; i < scenarios.length; i += batchSize) {
      const batch = scenarios.slice(i, i + batchSize);
      const results = await dock.eval(`require('electron').ipcRenderer.invoke('componentDock:test-resolve', ${JSON.stringify(batch)})`);
      results.forEach((result, index) => assertScenario(batch[index], result, failures));
    }
    if (failures.length) {
      console.log(`DOCK_FUZZ_FAIL ${scenarios.length} 场景, ${failures.length} 失败`);
      failures.slice(0, 25).forEach((f) => console.log('  - ' + f));
      process.exitCode = 1;
    } else {
      console.log(`DOCK_FUZZ_OK ${scenarios.length} 场景全部通过（无重叠 + 焦点/锚边不变）`);
    }
  } finally { if (dock) dock.close(); if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} await wait(450); } }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
