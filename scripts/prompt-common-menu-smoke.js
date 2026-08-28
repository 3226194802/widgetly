const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = Number(process.argv[2] || 9531);
const outputDir = process.argv[3] || path.join('F:\\', `Widgetly-test-prompt-common-menu-${Date.now()}`);
const profileDir = path.join(outputDir, 'profile');
const instanceId = 'audit-prompt';
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false,
  openManagerOnStart: false,
  closeToTray: true,
  pinToDesktop: false,
  clickThroughShortcut: 'CommandOrControl+Alt+Shift+P',
  instances: [{
    id: instanceId,
    widgetId: 'promptOptimizer',
    x: 100,
    y: 100,
    config: { strength: 1, bgOpacity: 0.4 },
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
      const found = (await pages()).find(match);
      if (found) return found;
    } catch (_) {}
    await wait(90);
  }
  throw new Error('Target timeout');
}

function isPrompt(page) {
  try {
    const url = new URL(page.url);
    return url.pathname.endsWith('/widgets/prompt/index.html') && url.searchParams.get('inst') === instanceId;
  } catch (_) { return false; }
}

function isMenu(page) {
  try {
    const url = new URL(page.url);
    return url.pathname.endsWith('/widgets/common/menu.html') && url.searchParams.get('inst') === instanceId;
  } catch (_) { return false; }
}

async function openMenu(prompt) {
  await prompt.eval(`document.getElementById('settingsButton').click();true`);
  const target = await waitFor(isMenu);
  const menu = new Cdp(target.webSocketDebuggerUrl);
  await menu.ready;
  const ready = await menu.eval(`new Promise((resolve)=>{
    const started=Date.now();
    const check=()=>document.querySelector('input[type=range]')?resolve(true):Date.now()-started>5000?resolve(false):setTimeout(check,50);
    check();
  })`);
  if (!ready) throw new Error('Common menu did not become ready');
  return { target, menu };
}

(async () => {
  if (!fs.existsSync(electronExe)) throw new Error(`Electron runtime not found: ${electronExe}`);
  const output = [];
  let child;
  let prompt;
  try {
    child = spawn(electronExe, [
      appDir,
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--widgetly-test-mode',
    ], { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));

    const promptTarget = await waitFor(isPrompt);
    prompt = new Cdp(promptTarget.webSocketDebuggerUrl);
    await prompt.ready;
    await prompt.eval(`new Promise((resolve)=>document.readyState==='complete'?resolve(true):addEventListener('load',()=>resolve(true),{once:true}))`);

    const first = await openMenu(prompt);
    const firstState = await first.menu.eval(`({
      text:document.body.innerText,
      itemTexts:[...document.querySelectorAll('.item')].map((item)=>item.innerText),
      sliderCount:document.querySelectorAll('input[type=range]').length,
      size:[innerWidth,innerHeight]
    })`);
    const clickedStrength2 = await first.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('强度 2'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    first.menu.close();
    await wait(350);
    const strengthAfterClick = Number(await prompt.eval(`window.widgetlyPrompt.init().then((value)=>value.strength)`));

    const second = await openMenu(prompt);
    const checkedStrength2 = await second.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('强度 2'));
      return !!item&&item.classList.contains('on')&&item.querySelector('.mark').textContent==='✓';
    })()`);
    const clickedAbout = await second.menu.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((node)=>node.textContent.includes('关于开源组件'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    second.menu.close();
    await wait(300);
    const aboutVisible = await prompt.eval(`!document.getElementById('aboutPanel').hidden`);
    const remainingMenus = (await pages()).filter(isMenu).length;
    const persisted = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const persistedStrength = persisted.instances.find((item) => item.id === instanceId).config.strength;
    const result = {
      separateWindow: first.target.id !== promptTarget.id,
      firstState,
      clickedStrength2,
      strengthAfterClick,
      checkedStrength2,
      clickedAbout,
      aboutVisible,
      remainingMenus,
      persistedStrength,
      outputDir,
    };
    const required = ['打开专业工作台', '配置 AI 模型', '强度 1', '强度 2', '强度 3', '关于开源组件', '背景透明度'];
    if (!result.separateWindow || firstState.sliderCount !== 1
      || required.some((label) => !firstState.text.includes(label))
      || !clickedStrength2 || strengthAfterClick !== 2 || !checkedStrength2
      || !clickedAbout || !aboutVisible || remainingMenus !== 0 || persistedStrength !== 2) {
      throw new Error(`Prompt common menu regression: ${JSON.stringify(result)}`);
    }
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(outputDir, 'process-output.txt'), output.join(''), 'utf8');
    console.log('PROMPT_COMMON_MENU|' + JSON.stringify(result));
  } finally {
    if (prompt) prompt.close();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (_) {}
      await wait(500);
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
