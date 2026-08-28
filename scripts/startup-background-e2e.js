const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const runtimeExe = process.env.WIDGETLY_RUNTIME_EXE || electronExe;
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const outputDir = process.argv[2] || path.join('F:/', `Widgetly-test-startup-background-${stamp}`);
const profileDir = path.join(outputDir, 'profile');
const debugPort = Number(process.argv[3] || 9551);

fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify({
  autostart: false,
  openManagerOnStart: false,
  closeToTray: true,
  pinToDesktop: false,
  instances: [],
}, null, 2));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pages() {
  try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch (_) { return null; }
}
async function waitFor(predicate, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await wait(80);
  }
  throw new Error('Timed out waiting for expected app state');
}
function hasManager(list) {
  return list.some((page) => /manager[\\/]index\.html/.test(String(page.url || '')));
}
function launch(extra = []) {
  const launchArgs = runtimeExe === electronExe
    ? [appDir, `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, '--widgetly-test-mode', ...extra]
    : [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, '--widgetly-test-mode', ...extra];
  return spawn(runtimeExe, launchArgs, {
    cwd: appDir,
    windowsHide: true,
    stdio: 'ignore',
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, wait(1500)]);
}

(async () => {
  if (!fs.existsSync(runtimeExe)) throw new Error('Widgetly runtime not found');
  let primary;
  let duplicateBackground;
  let foregroundRequest;
  let enabledStartup;
  try {
    // 1. 新版注册表/启动文件夹/计划任务均会传入此参数：不允许弹出组件坞。
    primary = launch(['--widgetly-background']);
    await waitFor(async () => Array.isArray(await pages()));
    await wait(1200);
    const afterBackgroundStart = await pages() || [];

    // 2. 模拟 Windows 在登录阶段把同一开机项又唤醒一次；仍不能弹窗。
    duplicateBackground = launch(['--widgetly-background']);
    await wait(1000);
    const afterDuplicateBackground = await pages() || [];

    // 3. 即使是旧版残留的无参数重复启动，只要用户关闭该设置，也保持后台。
    const legacyDuplicate = launch([]);
    await wait(1000);
    const afterLegacyDuplicate = await pages() || [];
    try { legacyDuplicate.kill(); } catch (_) {}

    // 4. 托盘入口才是关闭“启动时打开组件坞”后的显式打开路径。
    // 这里通过主进程的前台 activate 语义模拟，验证该设置不会妨碍用户主动打开。
    foregroundRequest = launch(['--widgetly-test-open-manager']);
    await wait(700);
    // 测试模式下不接受未知参数作为打开指令，因此只验证重复请求不会擅自打开；
    // 真正的显式入口由托盘 createManagerWindow 直接调用，已由主进程单独覆盖。
    const afterForegroundRequest = await pages() || [];

    // 5. 用户重新打开该设置后，即使开机项仍带旧的后台参数，也应恢复显示主界面。
    await stop(primary);
    primary = null;
    const enabledConfig = JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8'));
    enabledConfig.openManagerOnStart = true;
    fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify(enabledConfig, null, 2));
    enabledStartup = launch(['--widgetly-background']);
    await waitFor(async () => hasManager((await pages()) || []));
    const afterEnabledStart = await pages() || [];

    const result = {
      outputDir,
      managerAfterBackgroundStart: hasManager(afterBackgroundStart),
      managerAfterDuplicateBackground: hasManager(afterDuplicateBackground),
      managerAfterLegacyDuplicate: hasManager(afterLegacyDuplicate),
      managerAfterUnmarkedRequest: hasManager(afterForegroundRequest),
      managerAfterEnabledStartup: hasManager(afterEnabledStart),
      config: JSON.parse(fs.readFileSync(path.join(profileDir, 'config.json'), 'utf8')).openManagerOnStart,
    };
    if (result.managerAfterBackgroundStart || result.managerAfterDuplicateBackground || result.managerAfterLegacyDuplicate || result.managerAfterUnmarkedRequest || !result.managerAfterEnabledStartup || result.config !== true) {
      throw new Error('Background startup regression: ' + JSON.stringify(result));
    }
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log('STARTUP_BACKGROUND_E2E|' + JSON.stringify(result));
  } finally {
    for (const child of [enabledStartup, foregroundRequest, duplicateBackground, primary]) await stop(child);
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
