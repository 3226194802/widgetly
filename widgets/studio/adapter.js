// 新一代桌面组件集合的主进程能力：文件夹访问与四日天气。
const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const IDS = new Set([
  'plannerCalendar', 'quadrantTasks', 'miniCalendarGlass', 'flipClock', 'cycleCountdown',
  'desktopFolder', 'analogClock', 'digitalClockGlass', 'stickyNote', 'lineWeather',
  'desktopSchedule', 'markdownNote', 'desktopCounter', 'classSchedule', 'progressTracker', 'simplePomodoro',
  'clockCalendar', 'durationTimer', 'alarmClock',
]);

function isStudioWidget(id) { return IDS.has(String(id || '')); }

function getJson(url, timeout = 14000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    const request = https.get(url, { timeout, headers: { 'User-Agent': 'Widgetly/0.3' } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); finish(null); return; }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { if (text.length < 2_000_000) text += part; });
      response.on('end', () => { try { finish(JSON.parse(text)); } catch (_) { finish(null); } });
    });
    request.on('timeout', () => { request.destroy(); finish(null); });
    request.on('error', () => finish(null));
  });
}

async function weather(options) {
  const request = options && typeof options === 'object' ? options : { city: options };
  const place = String(request.city || '北京').trim().slice(0, 80) || '北京';
  let location = null;
  let automatic = request.autoLocation !== false;
  if (automatic) {
    const located = await getJson('https://ipwho.is/?fields=success,message,city,region,country,latitude,longitude,timezone');
    if (located && located.success !== false && Number.isFinite(Number(located.latitude)) && Number.isFinite(Number(located.longitude))) {
      location = { latitude: Number(located.latitude), longitude: Number(located.longitude), name: located.city || located.region || place };
    } else {
      automatic = false;
    }
  }
  if (!location) {
    const geo = await getJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(place) + '&count=1&language=zh&format=json');
    location = geo && Array.isArray(geo.results) && geo.results[0];
  }
  if (!location) return { ok: false, message: '无法定位，且找不到备用城市「' + place + '」' };
  const forecast = await getJson(
    'https://api.open-meteo.com/v1/forecast?latitude=' + location.latitude + '&longitude=' + location.longitude +
    '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4'
  );
  if (!forecast || !forecast.daily || !Array.isArray(forecast.daily.time)) return { ok: false, message: '天气服务暂时不可用' };
  return {
    ok: true,
    city: String(location.name || place),
    automatic,
    current: Math.round(Number(forecast.current && forecast.current.temperature_2m) || 0),
    updatedAt: Date.now(),
    days: forecast.daily.time.slice(0, 4).map((date, index) => ({
      date,
      code: Number(forecast.daily.weather_code[index]),
      high: Math.round(Number(forecast.daily.temperature_2m_max[index])),
      low: Math.round(Number(forecast.daily.temperature_2m_min[index])),
    })),
  };
}

function insideFolder(folder, candidate) {
  if (!folder || !candidate) return false;
  const root = path.resolve(folder);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function fileKind(item) {
  if (item.isDirectory()) return 'folder';
  const ext = path.extname(item.name).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'document';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['mp3', 'wav', 'flac', 'aac', 'mp4', 'mkv', 'mov'].includes(ext)) return 'media';
  if (['md', 'txt', 'log', 'json', 'js', 'ts', 'html', 'css'].includes(ext)) return 'text';
  return 'file';
}

function safeEntryName(value) {
  const name = String(value || '').trim().replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name)) return '';
  const stem = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return '';
  return name.slice(0, 120);
}

async function listFolder(rootFolder, requestedFolder = rootFolder) {
  if (!rootFolder) return { ok: false, empty: true, message: '请选择一个桌面文件夹' };
  const root = path.resolve(rootFolder);
  const folder = path.resolve(requestedFolder || root);
  if (!insideFolder(root, folder)) return { ok: false, message: '只能浏览所选文件夹内的内容' };
  try {
    const folderStat = await fs.promises.stat(folder);
    if (!folderStat.isDirectory()) return { ok: false, message: '该路径不是文件夹' };
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    const items = [];
    for (const entry of entries.slice(0, 300)) {
      const fullPath = path.join(folder, entry.name);
      let stat = null;
      try { stat = await fs.promises.stat(fullPath); } catch (_) {}
      items.push({
        name: entry.name,
        path: fullPath,
        type: fileKind(entry),
        isDirectory: entry.isDirectory(),
        size: stat && stat.isFile() ? stat.size : 0,
        modifiedAt: stat ? stat.mtimeMs : 0,
      });
    }
    items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'));
    const relative = path.relative(root, folder);
    return {
      ok: true,
      root,
      folder,
      relative: relative || '',
      canGoBack: folder !== root,
      parent: folder === root ? null : path.dirname(folder),
      items,
    };
  } catch (error) {
    const reason = error && (error.code || error.message);
    return { ok: false, message: '无法读取该文件夹：' + (reason || '未知错误') };
  }
}

function setup({ instance, win, save }) {
  const id = instance.id;
  let settingsWin = null;
  let systemAlarmTimer = null;
  let systemAlarmStopTimer = null;
  const handlers = [];
  const listeners = [];
  const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); handlers.push(channel); };
  const on = (channel, fn) => { ipcMain.on(channel, fn); listeners.push([channel, fn]); };
  const stopSystemAlarm = () => {
    clearInterval(systemAlarmTimer);
    clearTimeout(systemAlarmStopTimer);
    systemAlarmTimer = null;
    systemAlarmStopTimer = null;
  };
  const startSystemAlarm = (repeat = true) => {
    stopSystemAlarm();
    try { shell.beep(); } catch (_) {}
    if (!repeat) return;
    systemAlarmTimer = setInterval(() => {
      try { shell.beep(); } catch (_) {}
    }, 1800);
    // 即使组件无人操作也不让系统提示音无限播放。
    systemAlarmStopTimer = setTimeout(stopSystemAlarm, 60_000);
  };

  handle('studio:weather:' + id, (_event, options) => weather(options));
  handle('studio:folder-list:' + id, (_event, requestedFolder) => {
    const root = instance.config && instance.config.folder;
    return listFolder(root, requestedFolder || root);
  });
  handle('studio:folder-choose:' + id, async () => {
    const owner = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;
    const result = await dialog.showOpenDialog(owner, { title: '选择要显示的桌面文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    instance.config = { ...(instance.config || {}), folder: result.filePaths[0] };
    save();
    return listFolder(result.filePaths[0], result.filePaths[0]);
  });
  handle('studio:alarm-sound-choose:' + id, async () => {
    const owner = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;
    const result = await dialog.showOpenDialog(owner, {
      title: '选择闹钟提示声音',
      properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const source = path.resolve(result.filePaths[0]);
    try {
      const stat = await fs.promises.stat(source);
      if (!stat.isFile()) return { ok: false, message: '请选择一个音频文件' };
      if (stat.size > 20 * 1024 * 1024) return { ok: false, message: '音频文件不能超过 20 MB' };
      const extension = path.extname(source).toLowerCase();
      if (!['.wav', '.mp3', '.m4a', '.aac', '.ogg'].includes(extension)) return { ok: false, message: '仅支持 WAV、MP3、M4A、AAC 或 OGG 音频' };
      const fingerprint = crypto.createHash('sha256')
        .update(source + '|' + stat.size + '|' + stat.mtimeMs)
        .digest('hex').slice(0, 16);
      const targetDir = path.join(app.getPath('userData'), 'alarm-sounds');
      await fs.promises.mkdir(targetDir, { recursive: true });
      const safeId = String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'alarm';
      const target = path.join(targetDir, `${safeId}-${fingerprint}${extension}`);
      await fs.promises.copyFile(source, target);
      return { ok: true, filePath: target, fileName: path.basename(source) };
    } catch (error) {
      return { ok: false, message: '无法保存该声音：' + ((error && error.message) || '未知错误') };
    }
  });
  handle('studio:open-path:' + id, async (_event, target) => {
    const folder = instance.config && instance.config.folder;
    if (!insideFolder(folder, target)) return { ok: false, message: '路径不在当前文件夹内' };
    const resolved = path.resolve(target);
    try {
      await fs.promises.access(resolved, fs.constants.F_OK);
      const message = await shell.openPath(resolved);
      return message ? { ok: false, message: 'Windows 无法打开：' + message } : { ok: true };
    } catch (error) {
      return { ok: false, message: error && error.code === 'ENOENT' ? '文件或文件夹已经不存在' : '没有权限打开该项目' };
    }
  });
  handle('studio:create-folder:' + id, async (_event, currentFolder, requestedName) => {
    const root = instance.config && instance.config.folder;
    const current = path.resolve(currentFolder || root || '');
    const name = safeEntryName(requestedName);
    if (!root || !insideFolder(root, current)) return { ok: false, message: '只能在所选文件夹内新建内容' };
    if (!name) return { ok: false, message: '文件夹名称无效，请去掉特殊符号' };
    const target = path.join(current, name);
    if (!insideFolder(root, target)) return { ok: false, message: '新文件夹路径无效' };
    try {
      await fs.promises.mkdir(target);
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, message: error && error.code === 'EEXIST' ? '同名文件或文件夹已经存在' : '新建文件夹失败：' + ((error && error.code) || '未知错误') };
    }
  });
  handle('studio:rename-path:' + id, async (_event, target, requestedName) => {
    const root = instance.config && instance.config.folder;
    const source = path.resolve(target || '');
    const name = safeEntryName(requestedName);
    if (!root || !insideFolder(root, source) || source === path.resolve(root)) return { ok: false, message: '不能重命名所选的根文件夹' };
    if (!name) return { ok: false, message: '名称无效，请去掉特殊符号' };
    const destination = path.join(path.dirname(source), name);
    if (!insideFolder(root, destination)) return { ok: false, message: '新名称对应的路径无效' };
    try {
      await fs.promises.rename(source, destination);
      return { ok: true, path: destination };
    } catch (error) {
      return { ok: false, message: error && error.code === 'EEXIST' ? '同名项目已经存在' : '重命名失败：' + ((error && error.code) || '未知错误') };
    }
  });
  handle('studio:trash-path:' + id, async (_event, target) => {
    const root = instance.config && instance.config.folder;
    const resolved = path.resolve(target || '');
    if (!root || !insideFolder(root, resolved) || resolved === path.resolve(root)) return { ok: false, message: '不能删除所选的根文件夹' };
    try {
      await fs.promises.access(resolved, fs.constants.F_OK);
      const owner = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;
      const answer = await dialog.showMessageBox(owner, {
        type: 'warning', title: '移至回收站', message: '确定要把“' + path.basename(resolved) + '”移至回收站吗？',
        detail: '此操作不会永久删除，可在 Windows 回收站中恢复。', buttons: ['取消', '移至回收站'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (answer.response !== 1) return { ok: false, canceled: true };
      await shell.trashItem(resolved);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error && error.code === 'ENOENT' ? '该项目已经不存在' : '无法移至回收站：' + ((error && error.message) || '未知错误') };
    }
  });
  on('studio:show-item:' + id, (_event, target) => {
    const folder = instance.config && instance.config.folder;
    if (insideFolder(folder, target)) shell.showItemInFolder(path.resolve(target));
  });
  on('studio:notify:' + id, (_event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const title = String(data.title || 'Widgetly 提醒').slice(0, 80);
    const body = String(data.body || '时间到了').slice(0, 240);
    if (!data.soundHandled) {
      try { shell.beep(); } catch (_) {}
    }
    try {
      if (!Notification.isSupported()) return;
      // 声音由闹钟播放器单独控制，通知本身保持静音，避免 Windows 再响一次。
      const notice = new Notification({ title, body, silent: true });
      notice.on('click', () => {
        if (!win.isDestroyed()) { win.show(); win.focus(); }
      });
      notice.show();
    } catch (_) {}
  });
  on('studio:alarm-system-start:' + id, (_event, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    startSystemAlarm(data.repeat !== false);
  });
  on('studio:alarm-system-stop:' + id, stopSystemAlarm);

  const closeSettings = () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    settingsWin = null;
  };
  const openSettings = () => {
    if (win.isDestroyed()) return;
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show(); settingsWin.focus(); return;
    }
    settingsWin = new BrowserWindow({
      width: 520, height: 650, minWidth: 390, minHeight: 460,
      frame: false, transparent: true, resizable: true, maximizable: true, minimizable: true,
      fullscreenable: false, show: false, skipTaskbar: false, hasShadow: true,
      backgroundColor: '#00000000', title: 'Widgetly 组件设置',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const current = settingsWin;
    current.on('closed', () => { if (settingsWin === current) settingsWin = null; });
    current.once('ready-to-show', () => { if (!current.isDestroyed()) { current.show(); current.focus(); } });
    current.loadFile(path.join(__dirname, 'index.html'), { query: { inst: id, wid: instance.widgetId, settings: '1' } });
  };
  on('studio:settings-open:' + id, openSettings);
  on('studio:settings-close:' + id, closeSettings);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopSystemAlarm();
    closeSettings();
    handlers.forEach((channel) => ipcMain.removeHandler(channel));
    listeners.forEach(([channel, fn]) => ipcMain.removeListener(channel, fn));
  };
  win.on('closed', dispose);
  return { dispose };
}

module.exports = { IDS, isStudioWidget, setup };
