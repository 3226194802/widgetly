const api = window.widgetlyPrompt;
const $ = (id) => document.getElementById(id);
const workbenchUrl = '../../third_party/prompt-optimizer/web-dist/index.html#/basic/user';

let state = { bgOpacity: 0.4, strength: 1, draft: '', lastResult: '', workspaceMode: 'closed' };
let iframe = null;
let workbenchReady = false;
let pendingBridge = null;
let activeRequestId = '';
let draftSaveTimer = null;
let opacityHideTimer = null;

function setStatus(text, type = '') {
  $('miniStatus').textContent = text || '';
  $('miniStatus').className = `mini-status ${type}`;
}
function applyOpacity() {
  const opacity = Math.max(0, Math.min(1, Number(state.bgOpacity)));
  $('tint').style.opacity = String(opacity);
  const transparency = Math.round((1 - opacity) * 100);
  $('opacityInput').value = String(transparency);
  $('opacityValue').textContent = `${transparency}%`;
}
function applyResult(result, persist = true) {
  state.lastResult = String(result || '');
  const has = !!state.lastResult;
  document.body.classList.toggle('has-result', has);
  $('resultPanel').hidden = !has;
  $('resultText').textContent = state.lastResult;
  api.setResultExpanded(has);
  if (persist) api.saveResult(state.lastResult);
}
function applyState(next) {
  if (!next) return;
  const showAbout = !!next.showAbout;
  state = { ...state, ...next };
  if (typeof next.draft === 'string' && !$('promptInput').value) $('promptInput').value = next.draft;
  if (typeof next.lastResult === 'string' && !state._resultPainted) {
    state._resultPainted = true;
    applyResult(next.lastResult, false);
  }
  applyOpacity();
  if (showAbout) $('aboutPanel').hidden = false;
}
function requestId() {
  return `widgetly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function postBridge(type, extra = {}) {
  if (!iframe || !iframe.contentWindow || !workbenchReady) return false;
  iframe.contentWindow.postMessage({ source: 'widgetly-shell', type, ...extra }, '*');
  return true;
}
function destroyWorkbench() {
  pendingBridge = null;
  workbenchReady = false;
  activeRequestId = '';
  if (iframe) {
    try { iframe.src = 'about:blank'; } catch (_) {}
    iframe.remove();
    iframe = null;
  }
  $('workbenchHost').replaceChildren();
}
function leaveWorkspace() {
  destroyWorkbench();
  $('loadingLayer').hidden = true;
  $('workspaceShell').hidden = true;
  document.body.dataset.mode = 'mini';
  $('optimizeButton').disabled = false;
  api.closeWorkspace();
  $('promptInput').focus();
}
function ensureWorkbench({ visible, prompt, optimize, action = '' }) {
  const mode = visible ? 'visible' : 'quick';
  api.openWorkspace(mode);
  if (visible) {
    document.body.dataset.mode = 'workspace';
    $('workspaceShell').hidden = false;
  } else {
    $('loadingTitle').textContent = '正在启动专业优化引擎';
    $('loadingText').textContent = '完整工作台只会在本次优化期间加载，完成后自动释放。';
    $('loadingLayer').hidden = false;
  }
  pendingBridge = { visible, prompt, optimize, action };
  if (iframe && workbenchReady) {
    sendPendingBridge();
    return;
  }
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.className = 'workbench-frame';
    iframe.title = 'Prompt Optimizer 专业工作台';
    iframe.src = workbenchUrl;
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    $('workbenchHost').appendChild(iframe);
  }
}
function sendPendingBridge() {
  if (!pendingBridge || !workbenchReady) return;
  const pending = pendingBridge;
  pendingBridge = null;
  activeRequestId = requestId();
  postBridge(pending.action === 'model-settings'
    ? 'widgetly:open-model-manager'
    : (pending.optimize ? 'widgetly:optimize' : 'widgetly:hydrate'), {
    requestId: activeRequestId,
    prompt: pending.prompt,
    strength: state.strength,
  });
}
async function quickOptimize() {
  const prompt = $('promptInput').value.trim();
  if (!prompt) {
    setStatus('先输入需要优化的内容', 'error');
    $('promptInput').focus();
    return;
  }
  $('optimizeButton').disabled = true;
  setStatus('正在准备专业优化引擎…');
  ensureWorkbench({ visible: false, prompt, optimize: true });
}
function openProfessional() {
  const prompt = $('promptInput').value.trim();
  ensureWorkbench({ visible: true, prompt, optimize: false });
}

window.addEventListener('message', (event) => {
  if (!iframe || event.source !== iframe.contentWindow) return;
  const message = event.data;
  if (!message || message.source !== 'prompt-optimizer') return;
  if (message.type === 'widgetly:ready') {
    workbenchReady = true;
    sendPendingBridge();
    return;
  }
  if (message.requestId && activeRequestId && message.requestId !== activeRequestId) return;
  if (message.type === 'widgetly:optimizing') {
    $('loadingTitle').textContent = '正在优化提示词';
    $('loadingText').textContent = '正在使用专业工作台中选择的模型和模板。';
  } else if (message.type === 'widgetly:hydrated') {
    setStatus('已在专业工作台打开当前内容', 'ok');
  } else if (message.type === 'widgetly:result') {
    const result = String(message.result || '');
    destroyWorkbench();
    $('loadingLayer').hidden = true;
    api.closeWorkspace();
    applyResult(result);
    setStatus('优化完成', 'ok');
    $('optimizeButton').disabled = false;
  } else if (message.type === 'widgetly:needs-model') {
    $('loadingLayer').hidden = true;
    document.body.dataset.mode = 'workspace';
    $('workspaceShell').hidden = false;
    $('optimizeButton').disabled = false;
    api.openWorkspace('visible');
    setStatus('请先在专业工作台配置模型', 'error');
  } else if (message.type === 'widgetly:error') {
    const error = String(message.error || '优化失败');
    if (state.workspaceMode !== 'visible' && document.body.dataset.mode !== 'workspace') {
      destroyWorkbench();
      $('loadingLayer').hidden = true;
      api.closeWorkspace();
    }
    setStatus(error, 'error');
    $('optimizeButton').disabled = false;
  }
});

$('promptInput').addEventListener('input', () => {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => api.saveDraft($('promptInput').value), 260);
});
$('promptInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    quickOptimize();
  }
});
$('optimizeButton').addEventListener('click', quickOptimize);
$('workspaceButton').addEventListener('click', openProfessional);
$('settingsButton').addEventListener('click', api.openMenu);

// 组件本体右键菜单：先激活透明窗口，再阻止系统默认菜单。
// 仅在小组件/结果形态生效，专业工作台 iframe 内仍保留编辑器自己的右键行为。
$('miniShell').addEventListener('mousedown', (event) => {
  if (event.button === 2 && document.body.dataset.mode !== 'workspace') api.activate();
});
$('miniShell').addEventListener('contextmenu', (event) => {
  if (document.body.dataset.mode === 'workspace') return;
  event.preventDefault();
  api.activate();
  api.openMenu();
});
$('resultPanel').addEventListener('mousedown', (event) => {
  if (event.button === 2 && document.body.dataset.mode !== 'workspace') api.activate();
});
$('resultPanel').addEventListener('contextmenu', (event) => {
  if (document.body.dataset.mode === 'workspace') return;
  event.preventDefault();
  api.activate();
  api.openMenu();
});
$('copyButton').addEventListener('click', () => {
  api.writeClipboard(state.lastResult || '');
  setStatus('结果已复制', 'ok');
});
$('continueButton').addEventListener('click', () => {
  const prompt = state.lastResult || $('promptInput').value;
  ensureWorkbench({ visible: true, prompt, optimize: false });
});
$('doneButton').addEventListener('click', () => {
  applyResult('');
  setStatus('');
  $('promptInput').focus();
});
$('backButton').addEventListener('click', leaveWorkspace);
$('closeWorkspaceButton').addEventListener('click', leaveWorkspace);
$('minimizeButton').addEventListener('click', api.minimizeWorkspace);
$('maximizeButton').addEventListener('click', api.toggleMaximizeWorkspace);
$('cancelLoadingButton').addEventListener('click', () => {
  destroyWorkbench();
  $('loadingLayer').hidden = true;
  api.closeWorkspace();
  $('optimizeButton').disabled = false;
  setStatus('已取消');
});

function wireDrag(element) {
  element.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || state.locked) return;
    event.preventDefault();
    api.activate();
    api.startDrag();
  });
}
wireDrag($('dragStrip'));
wireDrag($('workspaceDrag'));
window.addEventListener('mouseup', api.endDrag);
window.addEventListener('blur', api.endDrag);
window.addEventListener('dblclick', (event) => {
  if (event.target.closest('.workspace-drag')) api.toggleMaximizeWorkspace();
  event.preventDefault();
}, true);

api.onForceMini(leaveWorkspace);
api.onShowOpacity(() => {
  $('opacityPanel').hidden = false;
  clearTimeout(opacityHideTimer);
  opacityHideTimer = setTimeout(() => { $('opacityPanel').hidden = true; }, 3500);
});
api.onOpenModelSettings(() => {
  ensureWorkbench({
    visible: true,
    prompt: $('promptInput').value.trim(),
    optimize: false,
    action: 'model-settings',
  });
});
$('opacityInput').addEventListener('input', () => {
  const transparency = Number($('opacityInput').value);
  state.bgOpacity = 1 - transparency / 100;
  applyOpacity();
  clearTimeout(opacityHideTimer);
});
$('opacityInput').addEventListener('change', () => {
  api.setOpacity(state.bgOpacity);
  opacityHideTimer = setTimeout(() => { $('opacityPanel').hidden = true; }, 1600);
});
$('closeAboutButton').addEventListener('click', () => { $('aboutPanel').hidden = true; });
$('aboutPanel').addEventListener('mousedown', (event) => {
  if (event.target === $('aboutPanel')) $('aboutPanel').hidden = true;
});

api.onState(applyState);
api.init().then((initial) => {
  applyState(initial);
  $('promptInput').focus();
}).catch(() => setStatus('组件初始化失败，请重新打开', 'error'));
