const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = Number(process.argv[2] || 9532);
const outputDir = process.argv[3] || path.join('F:\\', `Widgetly-test-dock-common-menu-${Date.now()}`);
const profileDir = path.join(outputDir, 'profile');
const instanceId = 'audit-dock';
const sampleFile = path.join(outputDir, 'menu-removal-sample.txt');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(sampleFile, 'Widgetly dock common menu audit', 'utf8');
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false,
  openManagerOnStart: false,
  closeToTray: true,
  pinToDesktop: false,
  clickThroughShortcut: 'CommandOrControl+Alt+Shift+D',
  instances: [{
    id: instanceId,
    widgetId: 'dock',
    x: 100,
    y: 100,
    config: { layout: '4x2', bgOpacity: 0.4, items: [{ path: sampleFile, name: '测试快捷方式' }] },
  }],
}, null, 2));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) {
    this.next = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  }
  close() { try { this.socket.close(); } catch (_) {} }
}

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((page) => page.type === 'page');
}
async function waitFor(match, timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const target = (await pages()).find(match);
      if (target) return target;
    } catch (_) {}
    await wait(90);
  }
  throw new Error('Target timeout');
}
function isDock(page) {
  try {
    const url = new URL(page.url);
    return url.pathname.endsWith('/widgets/dock/index.html') && url.searchParams.get('inst') === instanceId;
  } catch (_) { return false; }
}
function isMenu(page) {
  try {
    const url = new URL(page.url);
    return url.pathname.endsWith('/widgets/common/menu.html') && url.searchParams.get('inst') === instanceId;
  } catch (_) { return false; }
}
async function openMenu(dock, selector) {
  const point = await dock.eval(`(()=>{
    const target=document.querySelector(${JSON.stringify(selector)});
    if(!target)return null;
    const rect=target.getBoundingClientRect();
    return {x:rect.left+Math.min(20,rect.width/2),y:rect.top+Math.min(20,rect.height/2)};
  })()`);
  if (!point) throw new Error(`Dock target missing for ${selector}`);
  await dock.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1 });
  await dock.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1 });
  const target = await waitFor(isMenu);
  const menu = new Cdp(target.webSocketDebuggerUrl);
  await menu.ready;
  const ready = await menu.eval(`new Promise((resolve)=>{
    const started=Date.now();
    const check=()=>document.querySelector('input[type=range]')?resolve(true):Date.now()-started>5000?resolve(false):setTimeout(check,50);
    check();
  })`);
  if (!ready) throw new Error('Dock common menu did not become ready');
  return { target, menu };
}

(async () => {
  if (!fs.existsSync(electronExe)) throw new Error(`Electron runtime not found: ${electronExe}`);
  let child;
  let dock;
  try {
    child = spawn(electronExe, [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--widgetly-test-mode'], {
      cwd: appDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const target = await waitFor(isDock);
    dock = new Cdp(target.webSocketDebuggerUrl);
    await dock.ready;
    const itemReady = await dock.eval(`new Promise((resolve)=>{
      const started=Date.now();
      const check=()=>document.querySelector('.cell:not(.empty)')?resolve(true):Date.now()-started>8000?resolve(false):setTimeout(check,60);
      check();
    })`);
    if (!itemReady) throw new Error('Dock sample shortcut did not render');

    const first = await openMenu(dock, '.cell:not(.empty)');
    const firstState = await first.menu.eval(`({
      text:document.body.innerText,
      items:[...document.querySelectorAll('.item')].map((node)=>({text:node.innerText,on:node.classList.contains('on')})),
      sliderCount:document.querySelectorAll('input[type=range]').length,
      overflow:[document.querySelector('.menu').scrollHeight,document.querySelector('.menu').clientHeight]
    })`);
    const layoutLabels = firstState.items.filter((item) => item.text.includes('排列：'));
    const clickedLayout = await first.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('排列：3 × 3'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    first.menu.close();
    await wait(650);
    let saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const savedInstance = () => saved.instances.find((item) => item.id === instanceId);
    const layoutAfterClick = savedInstance().config.layout;
    const windowAfterLayout = await dock.eval(`({outerWidth,outerHeight,innerWidth,innerHeight})`);

    const second = await openMenu(dock, '.cell:not(.empty)');
    const selectedLayoutMarked = await second.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('排列：3 × 3'));
      return !!item&&item.classList.contains('on')&&item.querySelector('.mark').textContent==='✓';
    })()`);
    const clickedRemove = await second.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('移除此快捷方式'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    second.menu.close();
    await wait(500);
    saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const itemCountAfterRemove = savedInstance().config.items.length;
    const renderedItemsAfterRemove = Number(await dock.eval(`document.querySelectorAll('.cell:not(.empty)').length`));

    const third = await openMenu(dock, '.cell.empty');
    const blankState = await third.menu.eval(`({text:document.body.innerText,remove:[...document.querySelectorAll('.item')].some((node)=>node.textContent.includes('移除此快捷方式'))})`);
    third.menu.close();

    const result = {
      separateWindow: first.target.id !== target.id,
      firstState,
      layoutLabels: layoutLabels.length,
      clickedLayout,
      layoutAfterClick,
      windowAfterLayout,
      selectedLayoutMarked,
      clickedRemove,
      itemCountAfterRemove,
      renderedItemsAfterRemove,
      blankState,
      outputDir,
    };
    if (!result.separateWindow || firstState.sliderCount !== 1
      || !firstState.text.includes('打开此快捷方式') || !firstState.text.includes('移除此快捷方式')
      || layoutLabels.length !== 8 || !layoutLabels.find((item) => item.text.includes('4 × 2') && item.on)
      || !clickedLayout || layoutAfterClick !== '3x3' || !selectedLayoutMarked
      || windowAfterLayout.outerWidth !== 204 || windowAfterLayout.outerHeight !== 198
      || !clickedRemove || itemCountAfterRemove !== 0 || renderedItemsAfterRemove !== 0
      || blankState.remove || !blankState.text.includes('添加文件或文件夹')) {
      throw new Error(`Dock common menu regression: ${JSON.stringify(result)}`);
    }
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log('DOCK_COMMON_MENU|' + JSON.stringify(result));
  } finally {
    if (dock) dock.close();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (_) {}
      await wait(500);
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
