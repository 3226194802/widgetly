const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const common = read('widgets/common/adapter.js');

const routes = [
  ['studio-settings', "emit('studio:settings-open')", 'widgets/studio/adapter.js', "on('studio:settings-open:' + id, openSettings)"],
  ['dock-add', "emit('add')", 'widgets/dock/adapter.js', "on('add:' + instId, addShortcuts)"],
  ['dock-layout-*', "emit('dock:layout'", 'widgets/dock/adapter.js', "on('dock:layout:' + instId"],
  ['dock-open-selected', "emit('dock:open-selected'", 'widgets/dock/adapter.js', "on('dock:open-selected:' + instId"],
  ['dock-remove-selected', "emit('dock:remove-selected'", 'widgets/dock/adapter.js', "on('dock:remove-selected:' + instId"],
  ['gallery-settings', "emit('gallery:settings-open')", 'widgets/gallery/adapter.js', "ipcMain.on('gallery:settings-open:' + instId, openSettings)"],
  ['todo-settings', "emit('todo:settings-open')", 'widgets/todo/adapter.js', "ipcMain.on('todo:settings-open:' + instId, openSettings)"],
  ['todo-appearance', "emit('todo:appearance-open')", 'widgets/todo/adapter.js', "ipcMain.on('todo:appearance-open:' + instId, openAppearance)"],
  ['memory-appearance', "emit('memory:appearance-open')", 'widgets/memory/adapter.js', "ipcMain.on('memory:appearance-open:' + instId, openAppearance)"],
  ['monitor-platform', "emit('monitor:platform-open')", 'widgets/monitor/adapter.js', "ipcMain.on('monitor:platform-open:' + instId, openPlatform)"],
  ['monitor-appearance', "emit('monitor:appearance-open')", 'widgets/monitor/adapter.js', "ipcMain.on('monitor:appearance-open:' + instId, openAppearance)"],
  ['sysmon-settings', "emit('sysmon:settings-open')", 'widgets/sysmon/adapter.js', "ipcMain.on('sysmon:settings-open:' + instId, openSettings)"],
  ['sysmon-appearance', "emit('sysmon:appearance-open')", 'widgets/sysmon/adapter.js', "ipcMain.on('sysmon:appearance-open:' + instId, openAppearance)"],
  ['pomodoro-settings', "emit('pomodoro:settings-open')", 'widgets/pomodoro/adapter.js', "ipcMain.on('pomodoro:settings-open:' + instId, openSettings)"],
  ['clock2-appearance', "emit('clock2:appearance-open')", 'widgets/clock2/adapter.js', "ipcMain.on('clock2:appearance-open:' + instId, openAppearance)"],
  ['weather-refresh', "emit('weather:refresh')", 'widgets/weather/adapter.js', "ipcMain.on('weather:refresh:' + instId, refresh)"],
  ['weather-settings', "emit('weather:settings-open')", 'widgets/weather/adapter.js', "ipcMain.on('weather:settings-open:' + instId, openSettings)"],
  ['weather-appearance', "emit('weather:appearance-open')", 'widgets/weather/adapter.js', "ipcMain.on('weather:appearance-open:' + instId, openAppearance)"],
  ['countdown-settings', "emit('countdown:settings-open')", 'widgets/countdown/adapter.js', "on('countdown:settings-open:' + instId, openSettings)"],
  ['countdown-appearance', "emit('countdown:appearance-open')", 'widgets/countdown/adapter.js', "on('countdown:appearance-open:' + instId, openAppearance)"],
  ['prompt-workspace', "emit('prompt:workspace-open', 'visible')", 'widgets/prompt/adapter.js', 'on(`prompt:workspace-open:${instId}`'],
  ['prompt-model', "emit('prompt:model-settings')", 'widgets/prompt/adapter.js', 'on(`prompt:model-settings:${instId}`'],
  ['prompt-strength-[123]', "emit('prompt:strength'", 'widgets/prompt/adapter.js', 'on(`prompt:strength:${instId}`'],
  ['prompt-about', "emit('prompt:about')", 'widgets/prompt/adapter.js', 'on(`prompt:about:${instId}`'],
  ['launcher-settings', "emit('launcher:settings-open')", 'widgets/launcher/adapter.js', "ipcMain.on('launcher:settings-open:' + instId, openSettings)"],
  ['clock-appearance', "emit('clock:appearance-open')", 'widgets/clock/adapter.js', "ipcMain.on('clock:appearance-open:' + instId, openAppearance)"],
  ['calendar-appearance', "emit('cal:appearance-open')", 'widgets/calendar/adapter.js', "ipcMain.on('cal:appearance-open:' + instId, openAppearance)"],
];

const failures = [];
for (const [action, dispatch, file, registration] of routes) {
  if (!common.includes(dispatch)) failures.push(`${action}: common dispatch missing (${dispatch})`);
  const target = read(file);
  if (!target.includes(registration)) failures.push(`${action}: target listener missing in ${file} (${registration})`);
}

const studio = read('widgets/studio/adapter.js');
if (!/new BrowserWindow\(\{[\s\S]*?title:\s*'Widgetly 组件设置'/.test(studio)) failures.push('Studio settings is not a separate BrowserWindow');
if (!/loadFile\([^\n]+index\.html[^\n]+settings:\s*'1'/.test(studio)) failures.push('Studio settings BrowserWindow does not load settings=1');
if (/openLegacy/.test(common)) failures.push('Legacy submenu route still exists in common adapter');

const prompt = read('widgets/prompt/adapter.js');
if (/Menu\.buildFromTemplate/.test(prompt)) failures.push('Prompt still builds its old native menu');
if (!/function openMenu\(\)[\s\S]*?ipcMain\.emit\(`widgetly-common-menu:\$\{instId\}`\)/.test(prompt)) {
  failures.push('Prompt settings button is not routed into the common menu');
}

if (!common.includes("action: 'clock-copy-time'") || !common.includes("{ action: 'copy' }")) {
  failures.push('Clock copy-current-time action is not forwarded to the clock renderer');
}
const dock = read('widgets/dock/adapter.js');
if (/Menu\.buildFromTemplate|showBlankMenu|showGridMenu/.test(dock)) {
  failures.push('Dock still contains its legacy native context menu');
}

const result = {
  routeCount: routes.length,
  routes: routes.map(([action, dispatch, file]) => ({ action, dispatch, file })),
  studioSettingsSeparate: !failures.some((item) => item.startsWith('Studio settings')),
  promptUsesCommonMenu: !failures.some((item) => item.startsWith('Prompt')),
  noOpenLegacy: !/openLegacy/.test(common),
  failures,
};

console.log('COMMON_MENU_ROUTE_AUDIT|' + JSON.stringify(result));
if (failures.length) process.exitCode = 1;
