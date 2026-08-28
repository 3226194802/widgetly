const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = Number(process.argv[2] || 9461);
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const outputDir = process.argv[3] || path.join('F:\\', `Widgetly-test-menu-settings-lifecycle-${stamp}`);
const profileDir = path.join(outputDir, 'profile');
const screenshotDir = path.join(outputDir, 'screens');
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const ids = {
  clock: 'validation-clock',
  disposable: 'validation-disposable',
  companion: 'validation-companion',
};

fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  theme: 'dark',
  autostart: false,
  openManagerOnStart: false,
  closeToTray: true,
  managerOpacity: 0.5,
  pinToDesktop: false,
  // Use a free non-default accelerator so this isolated source run does not steal
  // the default from an already-open installed Widgetly used by the desktop session.
  clickThroughShortcut: 'CommandOrControl+Alt+Shift+Y',
  instances: [
    { id: ids.clock, widgetId: 'clock', x: 80, y: 80, config: { veilOpacity: 60 } },
    { id: ids.disposable, widgetId: 'digitalClockGlass', x: 420, y: 80, config: {} },
    { id: ids.companion, widgetId: 'miniCalendarGlass', x: 760, y: 80, config: {} },
  ],
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  }
  close() { try { this.socket.close(); } catch (_) {} }
}

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((page) => page.type === 'page');
}

async function waitFor(match, timeout = 18_000) {
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

async function waitForGone(match, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (!(await pages()).some(match)) return true;
    } catch (_) { return true; }
    await wait(90);
  }
  return false;
}

function targetForInstance(instanceId) {
  return (page) => {
    try {
      const url = new URL(page.url);
      return url.searchParams.get('inst') === instanceId
        && url.searchParams.get('settings') !== '1'
        && !url.pathname.endsWith('/widgets/common/menu.html');
    } catch (_) { return false; }
  };
}

function menuForInstance(instanceId) {
  return (page) => {
    try {
      const url = new URL(page.url);
      return url.pathname.endsWith('/widgets/common/menu.html')
        && url.searchParams.get('inst') === instanceId;
    } catch (_) { return false; }
  };
}

async function waitForMenuReady(target) {
  const client = new Cdp(target.webSocketDebuggerUrl);
  await client.ready;
  const ready = await client.eval(`new Promise((resolve)=>{
    const started=Date.now();
    const check=()=>{
      if(document.body&&document.querySelector('input[type=range]'))resolve(true);
      else if(Date.now()-started>5000)resolve(false);
      else setTimeout(check,50);
    };
    check();
  })`);
  if (!ready) throw new Error('Menu did not become ready');
  return client;
}

async function openMenu(host, instanceId) {
  const ready = await host.eval(`new Promise((resolve)=>{
    const started=Date.now();
    const check=()=>{
      if(document.body&&document.readyState!=='loading')resolve(true);
      else if(Date.now()-started>7000)resolve(false);
      else setTimeout(check,50);
    };
    check();
  })`);
  if (!ready) throw new Error(`Widget did not become ready: ${instanceId}`);
  const prevented = await host.eval(`(()=>{
    const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:60,clientY:60});
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  const target = await waitFor(menuForInstance(instanceId));
  const client = await waitForMenuReady(target);
  return { prevented, target, client };
}

async function capture(client, fileName) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const output = path.join(screenshotDir, fileName);
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
  return output;
}

function desktopCandidates() {
  const values = [
    path.join(os.homedir(), 'Desktop'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
    process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'),
    process.env.OneDriveConsumer && path.join(process.env.OneDriveConsumer, 'Desktop'),
  ].filter(Boolean);
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function crashLogsSince(startedAt) {
  const found = [];
  for (const directory of desktopCandidates()) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!/^Widgetly-异常日志-.*\.txt$/i.test(name)) continue;
        const file = path.join(directory, name);
        if (fs.statSync(file).mtimeMs >= startedAt - 250) found.push(file);
      }
    } catch (_) {}
  }
  return [...new Set(found)];
}

(async () => {
  if (!fs.existsSync(electronExe)) throw new Error(`Electron runtime not found: ${electronExe}`);
  const startedAt = Date.now();
  const processOutput = [];
  let child;
  let clock;
  try {
    child = spawn(electronExe, [
      appDir,
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--widgetly-test-mode',
    ], { cwd: appDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => processOutput.push(String(chunk)));
    child.stderr.on('data', (chunk) => processOutput.push(String(chunk)));
    const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    const clockTarget = await waitFor(targetForInstance(ids.clock), 30_000);
    await waitFor(targetForInstance(ids.disposable), 30_000);
    await waitFor(targetForInstance(ids.companion), 30_000);
    clock = new Cdp(clockTarget.webSocketDebuggerUrl);
    await clock.ready;

    // 1) Unified context menu: separate BrowserWindow, correct label/direction, outside-click dismissal.
    const firstMenu = await openMenu(clock, ids.clock);
    const hostGeometry = await clock.eval(`({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight})`);
    const menuState = await firstMenu.client.eval(`({
      text:document.body.innerText,
      sliderCount:document.querySelectorAll('input[type=range]').length,
      sliderValue:Number(document.querySelector('input[type=range]').value),
      valueText:document.querySelector('.slider-head b').textContent,
      size:[innerWidth,innerHeight],
      geometry:{screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight},
      bodyOverflow:[document.body.scrollWidth-innerWidth,document.body.scrollHeight-innerHeight],
      opener:!!window.opener
    })`);
    const menuScreenshot = await capture(firstMenu.client, 'unified-menu.png');
    await clock.eval(`require('electron').ipcRenderer.send('activate');true`);
    const dismissedOutside = await waitForGone(menuForInstance(ids.clock));
    firstMenu.client.close();

    const secondMenu = await openMenu(clock, ids.clock);
    const setTransparency = async (value) => {
      await secondMenu.client.eval(`(()=>{
        const input=document.querySelector('input[type=range]');
        input.value='${value}';
        input.dispatchEvent(new Event('input',{bubbles:true}));
        input.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      await wait(320);
      return {
        transparency: Number(await secondMenu.client.eval(`document.querySelector('input[type=range]').value`)),
        label: await secondMenu.client.eval(`document.querySelector('.slider-head b').textContent`),
        alpha: Number(await clock.eval(`Number(getComputedStyle(document.documentElement).getPropertyValue('--veil-opacity'))`)),
      };
    };
    const at100 = await setTransparency(100);
    const at0 = await setTransparency(0);
    const at63 = await setTransparency(63);
    await secondMenu.client.eval(`require('electron').ipcRenderer.send('widgetly-menu:close:${ids.clock}');true`);
    const dismissedExplicitly = await waitForGone(menuForInstance(ids.clock));
    secondMenu.client.close();

    const copyMenu = await openMenu(clock, ids.clock);
    const clickedCopyTime = await copyMenu.client.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((el)=>el.textContent.includes('复制当前时间'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    await wait(220);
    const copiedTime = await clock.eval(`require('electron').clipboard.readText()`);
    const copyMenuDismissed = await waitForGone(menuForInstance(ids.clock));
    copyMenu.client.close();

    const menuResult = {
      contextPrevented: firstMenu.prevented && secondMenu.prevented,
      separateWindow: firstMenu.target.id !== clockTarget.id && !menuState.opener,
      hostTargetId: clockTarget.id,
      menuTargetId: firstMenu.target.id,
      hostGeometry,
      menuState,
      dismissedOutside,
      dismissedExplicitly,
      clickedCopyTime,
      copiedTime,
      copyMenuDismissed,
      at100,
      at0,
      at63,
      screenshot: menuScreenshot,
    };
    if (!menuResult.contextPrevented || !menuResult.separateWindow
      || menuState.sliderCount !== 1 || !menuState.text.includes('背景透明度')
      || !menuState.text.includes('Ctrl + Alt + Shift + Y')
      || menuState.sliderValue !== 60 || menuState.valueText !== '60%'
      || menuState.opener || !dismissedOutside || !dismissedExplicitly
      || !menuState.text.includes('复制当前时间') || !clickedCopyTime || !copyMenuDismissed
      || !/^\d{2}:\d{2}$/.test(copiedTime)
      || at100.label !== '100%' || at100.alpha > 0.01
      || at0.label !== '0%' || at0.alpha < 0.99
      || at63.label !== '63%' || Math.abs(at63.alpha - 0.37) > 0.011) {
      throw new Error(`Unified menu regression: ${JSON.stringify(menuResult)}`);
    }
    console.log('MENU_VALIDATION|' + JSON.stringify(menuResult));

    // 2) Settings page: record, save, verify registration, restore default, and inspect layout.
    await clock.eval(`require('electron').ipcRenderer.send('settings-open');true`);
    const settingsTarget = await waitFor((page) => page.url.endsWith('/manager/settings.html'));
    const settings = new Cdp(settingsTarget.webSocketDebuggerUrl);
    await settings.ready;
    await wait(450);
    const initialShortcut = await settings.eval(`require('electron').ipcRenderer.invoke('clickThroughShortcut:get')`);
    await settings.eval(`(()=>{
      const recorder=document.getElementById('shortcutRecorder');
      recorder.click();
      window.dispatchEvent(new KeyboardEvent('keydown',{
        key:'U',code:'KeyU',ctrlKey:true,altKey:true,shiftKey:true,bubbles:true,cancelable:true
      }));
      return {text:recorder.textContent,status:document.getElementById('shortcutStatus').textContent};
    })()`);
    const recordedState = await settings.eval(`({
      text:document.getElementById('shortcutRecorder').textContent,
      status:document.getElementById('shortcutStatus').textContent,
      recording:document.getElementById('shortcutRecorder').classList.contains('recording')
    })`);
    await settings.eval(`document.getElementById('btnSaveShortcut').click();true`);
    await wait(500);
    const savedShortcut = await settings.eval(`require('electron').ipcRenderer.invoke('clickThroughShortcut:get')`);
    const savedUi = await settings.eval(`({
      text:document.getElementById('shortcutRecorder').textContent,
      status:document.getElementById('shortcutStatus').textContent,
      success:document.getElementById('shortcutStatus').classList.contains('success')
    })`);
    await settings.eval(`document.getElementById('btnResetShortcut').click();true`);
    await wait(550);
    const resetShortcut = await settings.eval(`require('electron').ipcRenderer.invoke('clickThroughShortcut:get')`);
    const layout = await settings.eval(`(()=>{
      const win=document.querySelector('.win');
      const recorder=document.getElementById('shortcutRecorder');
      const save=document.getElementById('btnSaveShortcut');
      const reset=document.getElementById('btnResetShortcut');
      const rects=[recorder,save,reset].map((el)=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {
        viewport:[innerWidth,innerHeight],
        htmlOverflow:[document.documentElement.scrollWidth-innerWidth,document.documentElement.scrollHeight-innerHeight],
        panel:{clientWidth:win.clientWidth,scrollWidth:win.scrollWidth,clientHeight:win.clientHeight,scrollHeight:win.scrollHeight},
        rects,
        visible:rects.every((r)=>r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight),
        text:document.body.innerText
      };
    })()`);
    const settingsScreenshot = await capture(settings, 'settings-shortcut.png');
    const settingsResult = {
      initialShortcut,
      recordedState,
      savedShortcut,
      savedUi,
      resetShortcut,
      resetMode: (resetShortcut.configuredShortcut === resetShortcut.defaultShortcut
        && resetShortcut.activeShortcut === resetShortcut.defaultShortcut && resetShortcut.registered)
        ? 'default-restored'
        : 'default-conflict-previous-restored',
      layout,
      screenshot: settingsScreenshot,
    };
    const resetSucceeded = resetShortcut.configuredShortcut === resetShortcut.defaultShortcut
      && resetShortcut.activeShortcut === resetShortcut.defaultShortcut && resetShortcut.registered;
    const resetConflictHandled = resetShortcut.configuredShortcut === 'CommandOrControl+Alt+Shift+U'
      && resetShortcut.activeShortcut === 'CommandOrControl+Alt+Shift+U' && resetShortcut.registered
      && /占用|原快捷键已恢复/.test(resetShortcut.message || '');
    if (initialShortcut.configuredShortcut !== 'CommandOrControl+Alt+Shift+Y'
      || initialShortcut.activeShortcut !== 'CommandOrControl+Alt+Shift+Y' || !initialShortcut.registered
      || recordedState.recording || recordedState.text !== 'Ctrl + Alt + Shift + U'
      || !recordedState.status.includes('已录制')
      || savedShortcut.configuredShortcut !== 'CommandOrControl+Alt+Shift+U'
      || savedShortcut.activeShortcut !== 'CommandOrControl+Alt+Shift+U' || !savedShortcut.registered
      || !savedUi.success || !savedUi.status.includes('已保存')
      || (!resetSucceeded && !resetConflictHandled)
      || layout.htmlOverflow[0] > 0 || layout.panel.scrollWidth > layout.panel.clientWidth || !layout.visible
      || !layout.text.includes('鼠标穿透安全') || !layout.text.includes('恢复默认')) {
      throw new Error(`Shortcut settings regression: ${JSON.stringify(settingsResult)}`);
    }
    console.log('SETTINGS_VALIDATION|' + JSON.stringify(settingsResult));
    await settings.eval(`require('electron').ipcRenderer.send('settings-close');true`);
    settings.close();
    await waitForGone((page) => page.url.endsWith('/manager/settings.html'));

    // 3) Studio component settings must be a separate page.  Clicking the unified
    // menu entry must not reopen the legacy/native context menu inside the widget.
    const disposableTarget = await waitFor(targetForInstance(ids.disposable));
    const disposable = new Cdp(disposableTarget.webSocketDebuggerUrl);
    await disposable.ready;
    const settingsMenu = await openMenu(disposable, ids.disposable);
    const clickedStudioSettings = await settingsMenu.client.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((el)=>el.textContent.includes('组件设置'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    const studioSettingsTarget = await waitFor((page) => {
      try {
        const url = new URL(page.url);
        return url.pathname.endsWith('/widgets/studio/index.html')
          && url.searchParams.get('inst') === ids.disposable
          && url.searchParams.get('settings') === '1';
      } catch (_) { return false; }
    });
    const studioSettings = new Cdp(studioSettingsTarget.webSocketDebuggerUrl);
    await studioSettings.ready;
    await wait(450);
    const studioSettingsState = await studioSettings.eval(`({
      separateTarget:true,
      settingsPage:document.body.classList.contains('settings-page'),
      editorVisible:!document.getElementById('editor').hidden,
      title:document.getElementById('editorTitle').textContent,
      hasOpacityField:!!document.getElementById('editOpacity'),
      size:[innerWidth,innerHeight]
    })`);
    const nativeOrLegacyMenuTargets = (await pages()).filter((page) => {
      try {
        const url = new URL(page.url);
        return url.searchParams.get('inst') === ids.disposable
          && (url.pathname.endsWith('/widgets/common/menu.html')
            || /\/widgets\/(?!studio\/index\.html)[^/]+\/menu\.html$/i.test(url.pathname));
      } catch (_) { return false; }
    }).map((page) => page.url);
    const studioSettingsResult = {
      clickedStudioSettings,
      separateTarget: studioSettingsTarget.id !== disposableTarget.id,
      state: studioSettingsState,
      nativeOrLegacyMenuTargets,
    };
    if (!clickedStudioSettings || !studioSettingsResult.separateTarget
      || !studioSettingsState.settingsPage || !studioSettingsState.editorVisible
      || studioSettingsState.hasOpacityField || nativeOrLegacyMenuTargets.length) {
      throw new Error(`Studio settings routing regression: ${JSON.stringify(studioSettingsResult)}`);
    }
    console.log('STUDIO_SETTINGS_VALIDATION|' + JSON.stringify(studioSettingsResult));
    await studioSettings.eval(`require('electron').ipcRenderer.send('studio:settings-close:${ids.disposable}');true`);
    studioSettings.close();
    settingsMenu.client.close();
    await waitForGone((page) => {
      try {
        const url = new URL(page.url);
        return url.pathname.endsWith('/widgets/studio/index.html')
          && url.searchParams.get('inst') === ids.disposable
          && url.searchParams.get('settings') === '1';
      } catch (_) { return false; }
    });

    // 4) Destroy one widget through its menu; the remaining widget and app must stay alive.
    const disposableMenu = await openMenu(disposable, ids.disposable);
    const clickedRemove = await disposableMenu.client.eval(`(()=>{
      const item=[...document.querySelectorAll('.item')].find((el)=>el.textContent.includes('移除此组件'));
      if(!item)return false;
      item.click();
      return true;
    })()`);
    const disposableGone = await waitForGone(targetForInstance(ids.disposable));
    await wait(1300);
    const processAliveAfterDestroy = child.exitCode === null;
    const survivor = await clock.eval(`({alive:true,title:document.title,now:Date.now()})`);
    const outputAfterDestroy = processOutput.join('');
    const configAfterDestroy = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const companionTarget = await waitFor(targetForInstance(ids.companion));
    const companion = new Cdp(companionTarget.webSocketDebuggerUrl);
    await companion.ready;
    const companionAlive = await companion.eval(`({alive:true,title:document.title,now:Date.now()})`);
    companion.close();
    const logsAfterDestroy = crashLogsSince(startedAt);
    disposableMenu.client.close();
    disposable.close();

    const lifecycleBeforeExit = {
      clickedRemove,
      disposableGone,
      processAliveAfterDestroy,
      survivor,
      companionAlive,
      remainingIds: configAfterDestroy.instances.map((item) => item.id),
      objectDestroyedInOutput: /Object has been destroyed/i.test(outputAfterDestroy),
      newCrashLogs: logsAfterDestroy,
    };
    if (!clickedRemove || !disposableGone || !processAliveAfterDestroy || !survivor.alive || !companionAlive.alive
      || configAfterDestroy.instances.some((item) => item.id === ids.disposable)
      || lifecycleBeforeExit.objectDestroyedInOutput || logsAfterDestroy.length) {
      throw new Error(`Widget destruction regression: ${JSON.stringify(lifecycleBeforeExit)}`);
    }

    await clock.eval(`require('electron').ipcRenderer.send('quit-app');true`);
    clock.close();
    clock = null;
    const exit = await Promise.race([
      exitPromise,
      wait(10_000).then(() => ({ code: null, signal: 'timeout' })),
    ]);
    if (exit.signal === 'timeout') child.kill();
    await wait(350);
    const finalOutput = processOutput.join('');
    const finalCrashLogs = crashLogsSince(startedAt);
    const lifecycleResult = {
      ...lifecycleBeforeExit,
      exit,
      objectDestroyedInFinalOutput: /Object has been destroyed/i.test(finalOutput),
      finalCrashLogs,
    };
    if (exit.code !== 0 || lifecycleResult.objectDestroyedInFinalOutput || finalCrashLogs.length) {
      throw new Error(`Shutdown lifecycle regression: ${JSON.stringify(lifecycleResult)}`);
    }
    console.log('LIFECYCLE_VALIDATION|' + JSON.stringify(lifecycleResult));

    const saved = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    const persistedClock = saved.instances.find((item) => item.id === ids.clock);
    const summary = {
      outputDir,
      menu: menuResult,
      settings: settingsResult,
      studioSettings: studioSettingsResult,
      lifecycle: lifecycleResult,
      persistence: {
        backgroundTransparency: persistedClock && persistedClock.windowState && persistedClock.windowState.backgroundTransparency,
        alpha: persistedClock && persistedClock.config && persistedClock.config.veilOpacity,
        clickThroughShortcut: saved.clickThroughShortcut,
        remainingInstances: saved.instances.length,
      },
    };
    if (summary.persistence.backgroundTransparency !== 63
      || summary.persistence.alpha !== 63
      || summary.persistence.clickThroughShortcut !== resetShortcut.configuredShortcut
      || summary.persistence.remainingInstances !== 2) {
      throw new Error(`Persistence regression: ${JSON.stringify(summary.persistence)}`);
    }
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(outputDir, 'process-output.txt'), finalOutput, 'utf8');
    console.log('VALIDATION_RESULT|' + JSON.stringify(summary));
  } finally {
    if (clock) clock.close();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (_) {}
      await wait(500);
    }
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
