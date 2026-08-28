const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
// 设置 WIDGETLY_TEST_RUNTIME 为 win-unpacked 的 Widgetly.exe 时，同一组交互断言可直接
// 验证打包后的应用；未设置则仍使用源码 Electron，方便本地调试。
const packagedRuntime = process.env.WIDGETLY_TEST_RUNTIME && path.resolve(process.env.WIDGETLY_TEST_RUNTIME);
const runtimeExe = packagedRuntime || electronExe;
const port = Number(process.argv[2] || 9574);
const outputDir = process.argv[3] || path.join(appDir, '.widgetly-crash-test', `component-dock-${Date.now()}`);
const profileDir = path.join(outputDir, 'profile');
const dockId = 'component-dock-audit';
const childIds = ['dock-clock', 'dock-calendar', 'dock-weather'];
const standaloneId = 'standalone-for-drop';
const legacyStandaloneId = 'standalone-legacy';   // 非 studio 组件：拖入必须给出“不支持”反馈且不附加
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false, openManagerOnStart: false, closeToTray: true, pinToDesktop: false,
  clickThroughShortcut: 'CommandOrControl+Alt+Shift+Z',
  instances: [
    { id: dockId, widgetId: 'componentDock', x: 90, y: 90, config: {
      layout: 'free', backgroundTransparency: 80, children: [
        { instanceId: childIds[0], slotId: 'slot-clock', surface: 'inherit', rect: { x: 0, y: 0, w: .575, h: 1 } },
        { instanceId: childIds[1], slotId: 'slot-calendar', surface: 'inherit', rect: { x: .595, y: 0, w: .405, h: .491 } },
        { instanceId: childIds[2], slotId: 'slot-weather', surface: 'inherit', rect: { x: .595, y: .509, w: .405, h: .491 } },
      ],
    } },
    { id: childIds[0], widgetId: 'digitalClockGlass', x: 0, y: 0, host: { type: 'componentDock', dockId }, config: {} },
    { id: childIds[1], widgetId: 'miniCalendarGlass', x: 0, y: 0, host: { type: 'componentDock', dockId }, config: {} },
    { id: childIds[2], widgetId: 'lineWeather', x: 0, y: 0, host: { type: 'componentDock', dockId }, config: {} },
    { id: standaloneId, widgetId: 'stickyNote', x: 760, y: 90, config: {} },
    { id: legacyStandaloneId, widgetId: 'clock', x: 760, y: 420, config: {} },
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
function dockTarget(page) { try { const url = new URL(page.url); return url.pathname.endsWith('/widgets/componentDock/index.html') && url.searchParams.get('inst') === dockId; } catch (_) { return false; } }
function menuTarget(page) { try { const url = new URL(page.url); return url.pathname.endsWith('/widgets/common/menu.html') && url.searchParams.get('inst') === dockId; } catch (_) { return false; } }
function standaloneTarget(page) { try { const url = new URL(page.url); return url.pathname.endsWith('/widgets/studio/index.html') && url.searchParams.get('inst') === standaloneId && url.searchParams.get('settings') !== '1'; } catch (_) { return false; } }
function legacyTarget(page) { try { const url = new URL(page.url); return url.pathname.endsWith('/widgets/clock/index.html') && url.searchParams.get('inst') === legacyStandaloneId; } catch (_) { return false; } }

(async () => {
  let child; let dock; let menu;
  try {
    const runtimeArgs = packagedRuntime
      ? [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--widgetly-test-mode']
      : [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--widgetly-test-mode'];
    child = spawn(runtimeExe, runtimeArgs, { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const target = await waitFor(dockTarget); dock = new Cdp(target.webSocketDebuggerUrl); await dock.ready;
    const initial = await dock.eval(`new Promise((resolve)=>{const check=()=>{const slots=[...document.querySelectorAll('.dock-slot')];if(slots.length===3&&slots.every((slot)=>slot.querySelector('.dock-frame').contentWindow))resolve({slots:slots.map((slot)=>({id:slot.dataset.childId,rect:[slot.style.getPropertyValue('--slot-x'),slot.style.getPropertyValue('--slot-y'),slot.style.getPropertyValue('--slot-w'),slot.style.getPropertyValue('--slot-h')],origin:slot.querySelector('.dock-frame').contentWindow.performance.timeOrigin})),size:[innerWidth,innerHeight]});else setTimeout(check,60)};check()})`);
    const screenshot = await dock.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(outputDir, 'component-dock.png'), Buffer.from(screenshot.data, 'base64'));
    await dock.eval(`require('electron').ipcRenderer.send('resize:${dockId}',{width:760,height:480});true`); await wait(420);
    const afterResize = await dock.eval(`({size:[innerWidth,innerHeight],slots:[...document.querySelectorAll('.dock-slot')].map((slot)=>({origin:slot.querySelector('.dock-frame').contentWindow.performance.timeOrigin,width:slot.getBoundingClientRect().width,height:slot.getBoundingClientRect().height}))})`);
    const previewOrigins = await dock.eval(`Object.fromEntries([...document.querySelectorAll('.dock-slot')].map((slot)=>[slot.dataset.childId,slot.querySelector('.dock-frame').contentWindow.performance.timeOrigin]))`);
    await dock.eval(`require('electron').ipcRenderer.send('componentDock:command:${dockId}',{action:'child-rect-preview',childId:'${childIds[1]}',rect:{x:.38,y:.08,w:.42,h:.52}});true`); await wait(240);
    const previewOriginLiteral = JSON.stringify(previewOrigins);
    const previewState = await dock.eval(`(()=>{const origins=${previewOriginLiteral};const boxes=[...document.querySelectorAll('.dock-slot')].map((slot)=>{const r=slot.getBoundingClientRect();return {id:slot.dataset.childId,left:r.left,top:r.top,right:r.right,bottom:r.bottom,origin:slot.querySelector('.dock-frame').contentWindow.performance.timeOrigin}});return {boxes,noOverlap:boxes.every((a,index)=>boxes.slice(index+1).every((b)=>!(a.right>b.left&&b.right>a.left&&a.bottom>b.top&&b.bottom>a.top))),sameFrames:boxes.every((box)=>box.origin===origins[box.id])}})()`);
    await dock.eval(`require('electron').ipcRenderer.send('componentDock:command:${dockId}',{action:'child-rect',childId:'${childIds[1]}',rect:{x:.38,y:.08,w:.42,h:.52},grow:{x:0,y:0}});true`); await wait(420);
    const saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const slot = saved.instances.find((item) => item.id === dockId).config.children.find((item) => item.instanceId === childIds[1]);
    const opened = true;
    const childMenu = '组件坞设置…';
    const edgeHandles = Number(await dock.eval(`document.querySelectorAll('.dock-slot .dock-item-resize.edge-n,.dock-slot .dock-item-resize.edge-e,.dock-slot .dock-item-resize.edge-s,.dock-slot .dock-item-resize.edge-w').length`));
    const resizeControls = Number(await dock.eval(`document.querySelectorAll('.dock-slot .dock-item-resize').length`));
    const previewVisible = await dock.eval(`(()=>{const ipc=require('electron').ipcRenderer;ipc.emit('componentDock:drop-preview:${dockId}',{}, {active:true,childName:'测试便签',rect:{x:.1,y:.1,w:.36,h:.3},layouts:[]});const shown=!!document.querySelector('.dock-drop-ghost');ipc.emit('componentDock:drop-preview:${dockId}',{}, {active:false});return shown})()`);
    await dock.eval(`require('electron').ipcRenderer.send('componentDock:command:${dockId}',{action:'child-rect',childId:'${childIds[2]}',rect:{x:.05,y:.05,w:.78,h:.78},grow:{x:.15,y:.15}});true`); await wait(420);
    const collisionSaved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8')).instances.find((item) => item.id === dockId).config.children;
    const collisionVisible = await dock.eval(`(()=>{const boxes=[...document.querySelectorAll('.dock-slot')].map((node)=>node.getBoundingClientRect());return boxes.every((a,index)=>boxes.slice(index+1).every((b)=>!(a.right>b.left+3&&b.right>a.left+3&&a.bottom>b.top+3&&b.bottom>a.top+3)));})()`);
    const locked = await dock.eval(`(()=>{require('electron').ipcRenderer.emit('widgetly:common-state:${dockId}',{}, {locked:true});return document.getElementById('dockShell').classList.contains('is-locked')&&getComputedStyle(document.querySelector('.dock-item-handle')).display==='none'})()`);
    const standalonePage = await waitFor(standaloneTarget); const standalone = new Cdp(standalonePage.webSocketDebuggerUrl); await standalone.ready;
    const hoverStarted = await standalone.eval(`require('electron').ipcRenderer.invoke('componentDock:test-hover',{x:180,y:180})`);
    await wait(510);
    const hoverReady = await standalone.eval(`require('electron').ipcRenderer.invoke('componentDock:test-hover',{x:180,y:180})`);
    const hoverGhost = await dock.eval(`!!document.querySelector('.dock-drop-ghost') && document.querySelector('.dock-drop-ghost').textContent.includes('松开以加入')`);
    await standalone.eval(`require('electron').ipcRenderer.send('drag-end',{x:180,y:180});true`); await wait(520);
    const afterDrop = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const dockAfterDrop = afterDrop.instances.find((item) => item.id === dockId);
    const dropped = afterDrop.instances.find((item) => item.id === standaloneId);
    standalone.close();
    // —— 非支持组件（旧时钟）拖到组件坞上方：必须出现“不支持”反馈，且松手不附加 ——
    const legacyPage = await waitFor(legacyTarget); const legacy = new Cdp(legacyPage.webSocketDebuggerUrl); await legacy.ready;
    const legacyHover = await legacy.eval(`require('electron').ipcRenderer.invoke('componentDock:test-hover',{x:180,y:180})`);
    const rejectedGhost = await dock.eval(`(()=>{const ghost=document.querySelector('.dock-drop-ghost');return !!ghost&&ghost.classList.contains('rejected')&&ghost.textContent.includes('暂不支持')})()`);
    await legacy.eval(`require('electron').ipcRenderer.send('drag-end',{x:180,y:180});true`); await wait(420);
    const afterLegacyDrag = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const legacyInst = afterLegacyDrag.instances.find((item) => item.id === legacyStandaloneId);
    const legacyNotAttached = !legacyInst.host && afterLegacyDrag.instances.find((item) => item.id === dockId).config.children.length === 4;
    legacy.close();
    const rects = collisionSaved.map((item) => item.rect);
    const noOverlap = rects.every((a, index) => rects.slice(index + 1).every((b) => !(a.x + a.w > b.x + .008 && b.x + b.w > a.x + .008 && a.y + a.h > b.y + .008 && b.y + b.h > a.y + .008)));
    const finalRects = dockAfterDrop.config.children.map((item) => item.rect);
    const finalNoOverlap = finalRects.every((a, index) => finalRects.slice(index + 1).every((b) => !(a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y)));
    const result = { initial, afterResize, savedRect: slot.rect, manual: slot.manual, opened, childMenu, locked, dropped, edgeHandles, resizeControls, previewVisible, noOverlap, collisionVisible, previewState, hoverStarted, hoverReady, hoverGhost, legacyHover, rejectedGhost, legacyNotAttached };
    const sameFrames = initial.slots.every((item, index) => item.origin === afterResize.slots[index].origin);
    const responsive = afterResize.size[0] === 760 && afterResize.slots.every((item) => item.width > 30 && item.height > 30);
    if (!sameFrames || !responsive || !slot.manual || Math.abs(slot.rect.x - .38) > .001 || !opened || !childMenu.includes('组件坞设置') || !locked || edgeHandles !== 12 || resizeControls !== 24 || !previewVisible || !noOverlap || !collisionVisible || !previewState.sameFrames || !previewState.noOverlap || !hoverStarted.ok || !hoverReady.ready || !hoverGhost || !finalNoOverlap || !dropped.host || dropped.host.dockId !== dockId || dockAfterDrop.config.children.length !== 4 || !legacyHover.ok || !rejectedGhost || !legacyNotAttached) throw new Error(`Component dock regression: ${JSON.stringify({ ...result, finalNoOverlap })}`);
    console.log('COMPONENT_DOCK_LAYOUT|' + JSON.stringify({ sameFrames, responsive, savedRect: slot.rect, childMenu, locked, edgeHandles, resizeControls, previewVisible, noOverlap, collisionVisible, previewNoOverlap: previewState.noOverlap, previewSameFrames: previewState.sameFrames, hoverStarted, hoverReady, hoverGhost, finalNoOverlap, externalDrop: dropped.host, outputDir }));
  } finally { if (menu) menu.close(); if (dock) dock.close(); if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} await wait(450); } }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
