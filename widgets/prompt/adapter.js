// AI 提示词优化组件 —— 主进程适配层
// 密钥只保存在用户自己的 %APPDATA%\Widgetly\config.json，渲染进程永远拿不到原文。
const { ipcMain, Menu, BrowserWindow, screen, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULTS = { bgOpacity: 0.4, pinned: false, locked: false, width: 360, height: 410, strength: 1, displayMode: 'large' };
const AI_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: '' };
const MODE_SIZES = {
  small: { width: 320, height: 270 },
  medium: { width: 350, height: 350 },
  large: { width: 360, height: 410 },
};
const HISTORY_LIMIT = 30;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function displayMode(value) { return ['small', 'medium', 'large'].includes(value) ? value : 'large'; }
function storedApiKey(raw = {}) {
  if (raw.apiKeyEncrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(String(raw.apiKeyEncrypted), 'base64'));
    } catch (_) {}
  }
  // 兼容未来可能存在的旧版明文配置；下次“测试并保存”会自动迁移到系统加密存储。
  return String(raw.apiKey || '');
}
function cleanConfig(raw = {}) {
  const baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(raw.model || '').trim();
  const apiKey = storedApiKey(raw).trim();
  return { baseUrl, model, apiKey };
}
function configForStorage(config) {
  const out = { baseUrl: config.baseUrl, model: config.model };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      out.apiKeyEncrypted = safeStorage.encryptString(config.apiKey).toString('base64');
      return out;
    }
  } catch (_) {}
  // 极少数系统无法使用 Electron 的 Windows 安全存储时，保留可用性；界面会提示用户密钥仅存本机。
  out.apiKey = config.apiKey;
  return out;
}
function publicAIConfig() {
  const saved = cleanConfig((global.__cfg && global.__cfg.aiPrompt) || {});
  return { baseUrl: saved.baseUrl || AI_DEFAULTS.baseUrl, model: saved.model, hasApiKey: !!saved.apiKey };
}
function apiEndpoint(baseUrl) {
  const cleaned = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) throw new Error('请填写 API 地址');
  return /\/chat\/completions$/i.test(cleaned) ? cleaned : cleaned + '/chat/completions';
}
function postJSON(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(urlString); } catch (_) { reject(new Error('API 地址格式不正确')); return; }
    const transport = target.protocol === 'http:' ? http : https;
    if (!transport) { reject(new Error('仅支持 http 或 https API 地址')); return; }
    const payload = JSON.stringify(body);
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 45000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const remote = parsed && parsed.error && (parsed.error.message || parsed.error.code);
          reject(new Error(`AI 服务返回 ${res.statusCode}${remote ? '：' + String(remote).slice(0, 240) : ''}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接 AI 服务超时（45 秒）')));
    req.on('error', (err) => reject(new Error('无法连接 AI 服务：' + (err && err.message ? err.message : '未知网络错误'))));
    req.write(payload);
    req.end();
  });
}
function instructionFor(level) {
  if (level === 1) return [
    '你是中文 AI 提示词润色助手。',
    '只做轻度润色：不改变用户真实意图、不补造需求、不扩大任务范围。',
    '把口语化、重复或含混的表达改成自然、清楚、可直接交给 AI 的指令。',
    '只输出润色后的提示词正文，不要解释、标题、问题或 Markdown 围栏。',
  ].join('\n');
  if (level === 2) return [
    '你是中文 AI 提示词优化助手。',
    '在不偏离原意的前提下，补足任务目标、必要上下文、输出要求和可执行步骤，让 AI 更容易一次做好。',
    '先输出“【优化后的提示词】”，再给出可直接使用的完整提示词。',
    '仅当缺失的信息会明显影响结果时，在最后输出“【可选确认问题】”，最多 2 个简短问题；否则不要该段。',
    '不得捏造用户未提供的事实、数据、身份或约束。',
  ].join('\n');
  return [
    '你是资深中文 AI 指令设计师。把用户原话改造成能让 AI 清晰理解、直接执行、尽量高效产出的高质量提示词。',
    '先准确提炼目标、背景、边界、交付物、格式、质量标准和执行顺序；消除歧义，但绝不能编造事实。',
    '输出结构固定为：\n【可直接使用的提示词】\n（完整、具体、可执行的指令）',
    '只有在关键信息缺失且会改变执行结果时，再附：\n【需要确认的问题】\n（不超过 3 个最关键、可回答的问题）。',
    '如果信息足够，就不要提问。不要输出分析过程、免责声明或无关建议。',
  ].join('\n');
}
async function runChat(config, messages, maxTokens = 1400) {
  if (!config.apiKey) throw new Error('请先配置 API Key');
  if (!config.model) throw new Error('请填写模型名称，例如 gpt-4o-mini');
  const body = {
    model: config.model,
    messages,
    temperature: 0.35,
    max_tokens: maxTokens,
  };
  const response = await postJSON(apiEndpoint(config.baseUrl), { Authorization: 'Bearer ' + config.apiKey }, body);
  const text = response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  if (!text || !String(text).trim()) throw new Error('AI 服务未返回可用内容，请检查模型和接口设置');
  return String(text).trim();
}

function setup({ instance, win, save }) {
  const instId = instance.id;
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let bgOpacity = typeof saved.bgOpacity === 'number' ? Math.max(0, Math.min(1, saved.bgOpacity)) : DEFAULTS.bgOpacity;
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  let width = clamp(saved.width, 320, 760, DEFAULTS.width);
  let height = clamp(saved.height, 240, 860, DEFAULTS.height);
  let mode = displayMode(saved.displayMode);
  let history = Array.isArray(saved.history) ? saved.history.filter((x) => x && typeof x === 'object').slice(0, HISTORY_LIMIT) : [];
  let historyWin = null;
  let configWin = null;

  function persist() {
    instance.config = { ...(instance.config || {}), bgOpacity, pinned, locked, width, height, displayMode: mode, history };
    save();
  }
  function state() { return { bgOpacity, pinned, locked, width, height, displayMode: mode, strength: clamp(instance.config && instance.config.strength, 1, 3, 1), ai: publicAIConfig() }; }
  function push() { if (win && !win.isDestroyed()) win.webContents.send('prompt:state:' + instId, state()); }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((x) => x.id !== instId);
    save();
    if (win && !win.isDestroyed()) win.close();
  }
  function openConfig() {
    if (configWin && !configWin.isDestroyed()) { configWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    configWin = new BrowserWindow({
      width: 430, height: 558,
      x: wa.x + Math.max(0, Math.round((wa.width - 430) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 558) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    configWin.loadFile(path.join(__dirname, 'settings.html'), { query: { inst: instId } });
    configWin.on('closed', () => { configWin = null; });
  }
  function openHistory() {
    if (historyWin && !historyWin.isDestroyed()) { historyWin.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    historyWin = new BrowserWindow({
      width: 470, height: 600,
      x: wa.x + Math.max(0, Math.round((wa.width - 470) / 2)), y: wa.y + Math.max(0, Math.round((wa.height - 600) / 2)),
      frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    historyWin.loadFile(path.join(__dirname, 'history.html'), { query: { inst: instId } });
    historyWin.on('closed', () => { historyWin = null; });
  }
  function addHistory(source, context, strength, text) {
    history.unshift({
      id: 'h' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      time: new Date().toISOString(), strength: clamp(strength, 1, 3, 1),
      source: String(source || '').slice(0, 6000), context: String(context || '').slice(0, 3000), text: String(text || '').slice(0, 9000),
    });
    history = history.slice(0, HISTORY_LIMIT);
    persist();
  }
  function setMode(nextMode) {
    mode = displayMode(nextMode);
    const preset = MODE_SIZES[mode];
    width = preset.width; height = preset.height;
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      win.setBounds({ x, y, width, height });
    }
    persist(); push();
  }
  function menu() {
    if (!win.isFocused()) win.focus();
    try {
      Menu.buildFromTemplate([
        { label: 'AI 与组件设置…', click: openConfig },
        { label: '历史对话…', click: openHistory },
        { label: '组件形态', submenu: [
          { label: '小形态（紧凑对话）', type: 'radio', checked: mode === 'small', click: () => setMode('small') },
          { label: '中形态（紧凑编辑）', type: 'radio', checked: mode === 'medium', click: () => setMode('medium') },
          { label: '大形态（完整工作台）', type: 'radio', checked: mode === 'large', click: () => setMode('large') },
        ] },
        { label: '优化强度', submenu: [1, 2, 3].map((value) => ({
          label: ['轻度：只润色', '增强：更清楚', '深度：完整指令'][value - 1], type: 'radio',
          checked: clamp(instance.config && instance.config.strength, 1, 3, 1) === value,
          click: () => { instance.config = { ...(instance.config || {}), strength: value }; save(); push(); },
        })) },
        { type: 'separator' },
        { label: '背景透明度…', click: () => win.webContents.send('show-opacity-panel:' + instId) },
        { label: '置顶显示', type: 'checkbox', checked: pinned, click: () => { pinned = !pinned; win.setAlwaysOnTop(pinned, 'floating'); persist(); push(); } },
        { label: '锁定位置', type: 'checkbox', checked: locked, click: () => { locked = !locked; persist(); push(); } },
        { type: 'separator' },
        { label: '退出此组件', click: quitWidget },
      ]).popup({ window: win });
    } catch (_) {}
  }

  ipcMain.handle('prompt:init:' + instId, () => state());
  ipcMain.on('prompt:menu:' + instId, menu);
  ipcMain.on('prompt:configure:' + instId, openConfig);
  ipcMain.on('prompt:history-open:' + instId, openHistory);
  ipcMain.on('prompt:bg-opacity:' + instId, (_e, value) => {
    if (typeof value !== 'number') return;
    bgOpacity = Math.max(0, Math.min(1, value));
    persist(); push();
  });
  ipcMain.on('prompt:strength:' + instId, (_e, value) => {
    const strength = clamp(value, 1, 3, 1);
    instance.config = { ...(instance.config || {}), strength };
    save(); push();
  });
  ipcMain.on('prompt:display-mode:' + instId, (_e, value) => setMode(value));
  ipcMain.on('prompt:resize:' + instId, (_e, size) => {
    width = clamp(size && size.width, 320, 760, width);
    height = clamp(size && size.height, 240, 860, height);
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width, height });
    persist();
  });
  ipcMain.handle('prompt:optimize:' + instId, async (_e, payload) => {
    const source = String(payload && payload.source || '').trim().slice(0, 16000);
    const context = String(payload && payload.context || '').trim().slice(0, 6000);
    const level = clamp(payload && payload.level, 1, 3, 1);
    if (!source) return { ok: false, error: '先粘贴或输入需要优化的内容' };
    try {
      const userText = context
        ? `用户原始内容：\n${source}\n\n用户补充说明（请一并考虑）：\n${context}`
        : `用户原始内容：\n${source}`;
      const text = await runChat(cleanConfig((global.__cfg && global.__cfg.aiPrompt) || {}), [
        { role: 'system', content: instructionFor(level) },
        { role: 'user', content: userText },
      ]);
      addHistory(source, context, level, text);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '优化失败，请检查 AI 配置' };
    }
  });
  ipcMain.handle('prompt:ai-config:' + instId, () => ({ ...publicAIConfig(), strength: clamp(instance.config && instance.config.strength, 1, 3, 1), displayMode: mode }));
  ipcMain.handle('prompt:ai-config-save:' + instId, async (_e, raw) => {
    const old = cleanConfig((global.__cfg && global.__cfg.aiPrompt) || {});
    const incoming = cleanConfig(raw || {});
    const config = { baseUrl: incoming.baseUrl || old.baseUrl || AI_DEFAULTS.baseUrl, model: incoming.model, apiKey: incoming.apiKey || old.apiKey };
    if (!config.apiKey) return { ok: false, error: '请填写 API Key' };
    if (!config.model) return { ok: false, error: '请填写模型名称' };
    try {
      if (raw && raw.test) await runChat(config, [{ role: 'user', content: '请只回复：连接成功' }], 16);
      global.__cfg.aiPrompt = configForStorage(config);
      save();
      push();
      return { ok: true, tested: !!(raw && raw.test) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '连接测试失败' };
    }
  });
  ipcMain.handle('prompt:history-get:' + instId, () => history.map((x) => ({ ...x })));
  ipcMain.on('prompt:history-use:' + instId, (_e, id) => {
    const item = history.find((x) => x.id === id);
    if (!item) return;
    if (win && !win.isDestroyed()) win.webContents.send('prompt:history-load:' + instId, { source: item.source, context: item.context, strength: item.strength });
    if (historyWin && !historyWin.isDestroyed()) historyWin.close();
  });
  ipcMain.on('prompt:history-delete:' + instId, (_e, id) => {
    history = history.filter((x) => x.id !== id); persist();
    if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send('prompt:history-changed:' + instId);
  });
  ipcMain.on('prompt:history-clear:' + instId, () => {
    history = []; persist();
    if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send('prompt:history-changed:' + instId);
  });
  ipcMain.on('prompt:history-close:' + instId, () => { if (historyWin && !historyWin.isDestroyed()) historyWin.close(); });
  ipcMain.on('prompt:settings-close:' + instId, () => { if (configWin && !configWin.isDestroyed()) configWin.close(); });

  // 菜单由 renderer 在右键按下阶段主动发送 prompt:menu，避免 textarea/Windows
  // 原生右键菜单和 Electron context-menu 事件在不同机器上互相抢占。
  win.webContents.on('did-finish-load', push);
  win.on('resize', () => {
    if (win.isDestroyed()) return;
    const [nextW, nextH] = win.getSize();
    const nextWidth = clamp(nextW, 320, 760, width);
    const nextHeight = clamp(nextH, 240, 860, height);
    if (nextWidth !== width || nextHeight !== height) { width = nextWidth; height = nextHeight; persist(); }
  });
  win.on('closed', () => { if (configWin && !configWin.isDestroyed()) configWin.close(); if (historyWin && !historyWin.isDestroyed()) historyWin.close(); });
  if (pinned) win.setAlwaysOnTop(true, 'floating');
}

module.exports = { setup };
