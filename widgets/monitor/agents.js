// 主流 Agent 平台注册表 —— 检测安装 + 读取本地用量数据
// 数据来源（本地文件，无需网络/API）：
//   Hermes/DSH: state.db（fetch_usage.py）
//   Claude Code: ~/.claude/projects/**/history.jsonl（total_cost_usd + usage tokens）
//   Codex: ~/.codex/sessions/**/*.jsonl（rollout，payload.message.usage）
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');

const HOME = os.homedir();
const LOCAP = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAM = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const hasZstd = typeof zlib.zstdDecompressSync === 'function';   // Node ≥22.17/23.2
const zstdDecompressAsync = hasZstd ? require('util').promisify(zlib.zstdDecompress) : null;

// ---------- DSH 会话解码（增量：按文件 mtime/size 缓存，仅解压追加的新帧；变化文件的活跃会话也几乎零开销） ----------
const dshFileCache = new Map();
// zstd 帧定位（DSH 官方算法移植：按帧头/块头扫描完整帧边界）
// startOffset：从该字节偏移继续扫描（增量解码）；resumeAt：下一个可安全恢复的偏移。
function scanZstdFrames(buffer, startOffset) {
  const frames = [];
  let offset = startOffset || 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, resumeAt: start };
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return { frames, resumeAt: start };
    offset += 4;
    const descriptor = buffer.readUInt8(offset); offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, resumeAt: start };
    offset += remainingHeaderBytes;
    let complete = true;
    for (;;) {
      if (buffer.length - offset < 3) { complete = false; break; }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { complete = false; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!complete) return { frames, resumeAt: start };
    if (checksum) { if (buffer.length - offset < 4) return { frames, resumeAt: start }; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames, resumeAt: offset };
}
// 增量解码单个文件（异步、分块让出事件循环）：
//   - 文件变大时只读追加的新字节、只解压新增帧（每轮轮询不再整读 24MB）；
//   - 首次/回退的全量解码每 512 帧让出一次事件循环，主进程界面永不卡死（修复"无响应"）。
// 返回 { records, nextOffset, model, steps }，供下次继续增量解码。
const yieldTurn = () => new Promise((r) => setImmediate(r));
async function decodeDshFileRangeAsync(file, startOffset, initialModel, initialSteps) {
  let b = null, base = startOffset || 0;
  if (base > 0) {
    try {
      const fd = fs.openSync(file, 'r');
      const st = fs.fstatSync(fd);
      if (st.size >= base) {
        const len = st.size - base;
        b = len > 0 ? (() => { const buf = Buffer.allocUnsafe(len); const got = fs.readSync(fd, buf, 0, len, base); return buf.subarray(0, got); })() : Buffer.alloc(0);
      } else { base = 0; }
      fs.closeSync(fd);
    } catch (_) { base = 0; }
  }
  if (!b) { b = fs.readFileSync(file); base = 0; }   // 全量（首次/回退）
  let { frames, resumeAt } = scanZstdFrames(b, 0);
  let absResume = base + resumeAt;
  // 从旧偏移续读但已不是帧边界（内容被原地改写）→ 回退全量重解
  if (base > 0 && frames.length === 0 && b.length > 0) {
    b = fs.readFileSync(file); base = 0;
    const full = scanZstdFrames(b, 0);
    frames = full.frames; absResume = full.resumeAt;
    initialModel = 'dsh'; initialSteps = new Map();
  }
  let model = initialModel || 'dsh';
  const steps = initialSteps || new Map();
  const push = (o) => {
    if (!o || !o.type) return;
    if (o.type === 'request/header') {
      const m = o.data && o.data.header && o.data.header.config && o.data.header.config.model;
      if (m) model = m;
      return;
    }
    let usage = null, ts = 0, turn = -1, step = -1;
    if (o.type === 'assistant/message' && o.data && o.data.usage) {
      usage = o.data.usage; ts = o.time || 0; turn = o.data.turn; step = o.data.step;
    } else if (o.type === 'assistant/chunk' && o.data && o.data.chunk && o.data.chunk.type === 'usage' && o.data.chunk.usage) {
      usage = o.data.chunk.usage; ts = o.time || 0; turn = o.data.turn; step = o.data.step;
    }
    if (usage && turn >= 0 && step >= 0) steps.set(turn + ':' + step, { usage, ts, model });
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const out = zlib.zstdDecompressSync(b.subarray(f.start, f.end));
    for (const line of out.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { push(JSON.parse(line)); } catch (_) {}
    }
    // 全量解码时每 512 帧（约 25ms）让出事件循环，界面保持响应
    if (base === 0 && (i & 511) === 0) await yieldTurn();
  }
  const records = [];
  for (const { usage, ts, model: m } of steps.values()) {
    if (!ts) continue;
    records.push({
      ts, model: m,
      input: usage.inputTokens || 0, output: usage.outputTokens || 0,
      cacheRead: usage.cacheReadTokens || 0, cacheWrite: usage.cacheWriteTokens || 0,
      reasoning: usage.reasoningTokens || 0, cost: 0,
    });
  }
  return { records, nextOffset: absResume, model, steps };
}
async function fetchDshSessionsAsync() {
  const files = [];
  walkFiles(path.join(DSH_HOME, 'sessions'), (n) => n === 'session.jsonl.zstd', files);
  const records = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    const cached = dshFileCache.get(f);
    // 未变化 → 直接复用缓存（空闲轮询零开销）
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      records.push(...cached.records);
      continue;
    }
    // 变化了 → 增量解码：仅在文件变大时从缓存偏移续解，否则全量
    let from = 0, model = 'dsh', steps = new Map();
    if (cached && st.size >= cached.size && cached.offset > 0) {
      from = cached.offset;
      model = cached.model || 'dsh';
      steps = cached.steps || new Map();
      if (from > st.size) { from = 0; model = 'dsh'; steps = new Map(); }
    }
    const res = await decodeDshFileRangeAsync(f, from, model, steps);
    dshFileCache.set(f, {
      mtimeMs: st.mtimeMs, size: st.size,
      offset: res.nextOffset, model: res.model, steps: res.steps, records: res.records,
    });
    records.push(...res.records);
  }
  return records;
}
function fetchDshProjcache() {
  // 回退：projcache（无 zstd 时；按会话创建时间归属，今天精度较低）
  const records = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'storages', 'session_projcache.json'), 'utf8'));
    const sessions = (data.tables && data.tables.sessions) || {};
    for (const v of Object.values(sessions)) {
      const tu = v.rows && v.rows.tokenUsage && v.rows.tokenUsage.val;
      const totals = tu && tu.totals;
      const ts = v.identity && v.identity.createdAt;
      if (!totals || !ts) continue;
      records.push({
        ts, model: 'dsh',
        input: totals.uncachedInputTokens || 0, output: totals.outputTokens || 0,
        cacheRead: totals.cacheReadTokens || 0, cacheWrite: totals.cacheWriteTokens || 0,
        reasoning: 0, cost: 0,
      });
    }
  } catch (_) {}
  return records;
}
function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
// 在 PATH 中查找命令（防误报：只认真实可执行文件，不认残留配置目录）
function findInPath(cmd) {
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const names = [cmd, cmd + '.exe', cmd + '.cmd', cmd + '.bat'];
  for (const dir of dirs) {
    try {
      for (const n of names) { if (exists(path.join(dir, n))) return path.join(dir, n); }
    } catch (_) {}
  }
  return null;
}
function findNpmGlobal(cmd) {
  for (const d of [path.join(ROAM, 'npm'), path.join(HOME, '.local', 'bin')]) {
    for (const n of [cmd, cmd + '.exe', cmd + '.cmd', cmd + '.ps1']) {
      const p = path.join(d, n);
      if (exists(p)) return p;
    }
  }
  return null;
}
function dateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayStart(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

function walkFiles(dir, filter, out) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (filter(e.name)) out.push(p);
    }
  }
}
function readJsonlLines(file, cb) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try { cb(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) {}
}

// ---------- 通用聚合：usage 记录 → 监控数据形状 ----------
function aggregate(records) {
  const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, cost: 0.0, calls: 0 });
  const totals = zero(), today = zero(), month = zero();
  const byModel = {};
  const trend = {};
  const t0 = dayStart(Date.now()), m0 = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  for (const r of records) {
    totals.input += r.input; totals.output += r.output; totals.cache_read += r.cacheRead;
    totals.cache_write += r.cacheWrite; totals.reasoning += r.reasoning; totals.cost += r.cost; totals.calls++;
    if (r.ts >= t0) { today.input += r.input; today.output += r.output; today.cache_read += r.cacheRead; today.cache_write += r.cacheWrite; today.reasoning += r.reasoning; today.cost += r.cost; today.calls++; }
    if (r.ts >= m0) { month.input += r.input; month.output += r.output; month.cache_read += r.cacheRead; month.cache_write += r.cacheWrite; month.reasoning += r.reasoning; month.cost += r.cost; month.calls++; }
    const key = r.model || '未知模型';
    const m = byModel[key] || (byModel[key] = { calls: 0, input: 0, output: 0, cache_read: 0, reasoning: 0, cost: 0 });
    m.calls++; m.input += r.input; m.output += r.output; m.cache_read += r.cacheRead; m.reasoning += r.reasoning; m.cost += r.cost;
    const dk = dateKey(r.ts);
    const t = trend[dk] || (trend[dk] = { billed: 0, cost: 0 });
    t.billed += r.input + r.cacheRead + r.output + r.reasoning; t.cost += r.cost;
  }
  const modelList = Object.entries(byModel)
    .map(([model, v]) => {
      const billed = v.input + v.cache_read + v.output + v.reasoning;
      return { model, ...v, rate: billed > 0 ? v.cost / billed * 1000 : 0 };
    })
    .sort((a, b) => (b.input + b.cache_read + b.output + b.reasoning) - (a.input + a.cache_read + a.output + a.reasoning)).slice(0, 5);
  const filled = [];
  for (let i = 6; i >= 0; i--) {
    const dk = dateKey(Date.now() - i * 86400000);
    const e = trend[dk] || { billed: 0, cost: 0 };
    filled.push({ date: dk.slice(5), billed: e.billed, cost: e.cost });
  }
  return {
    ok: true, fetched_at: new Date().toTimeString().slice(0, 8),
    totals, today, month, by_model: modelList, top_sessions_today: [],
    trend: filled, recent: null, active_24h: [], sessions_total: 0,
  };
}

// 通用扫描：遍历某目录下 jsonl，凡带 usage 字段的行都提取（Gemini/Antigravity 等未知格式尽力而为）
function scanUsage(dir, cb) {
  const files = [];
  walkFiles(dir, (n) => n.endsWith('.jsonl'), files);
  const records = [];
  for (const f of files) {
    readJsonlLines(f, (line) => {
      if (!line || !line.usage) return;
      const u = line.usage;
      const ts = typeof line.timestamp === 'number' ? line.timestamp : Date.parse(line.timestamp || '');
      if (isNaN(ts)) return;
      records.push({
        ts, model: line.model || 'agent',
        input: u.input_tokens || u.input || 0,
        output: u.output_tokens || u.output || 0,
        cacheRead: u.cache_read_input_tokens || u.cache_read_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || u.cache_write_tokens || 0,
        reasoning: u.reasoning_tokens || u.reasoning || 0,
        cost: typeof line.total_cost_usd === 'number' ? line.total_cost_usd : 0,
      });
    });
  }
  if (records.length) cb(aggregate(records));
  else cb({ ok: false, error: 'no_data', hint: '已检测到安装，但未找到可读的本地用量数据' });
}

// Hermes 数据库候选路径：HERMES_HOME 环境变量 → ~/.hermes → 本机常见安装位置
function hermesDbCandidates() {
  const root = process.env.HERMES_HOME || null;
  return [
    root && path.join(root, 'state.db'),
    root && path.join(root, 'profiles', 'code', 'state.db'),
    path.join(HOME, '.hermes', 'state.db'),
    path.join(HOME, '.hermes', 'profiles', 'code', 'state.db'),
    'C:/hermes/state.db',
    'C:/hermes/profiles/code/state.db',
  ].filter(Boolean);
}

const AGENTS = [
  {
    id: 'hermes', name: 'Hermes（桌面版）', short: 'Hermes', icon: '🐋', pricing: 'usage',
    detect() {
      const hit = hermesDbCandidates().find(exists);
      return hit ? { found: true, detail: hit } : { found: false, hint: '未找到 Hermes 数据（可设 HERMES_HOME 环境变量，或安装于 ~/.hermes）' };
    },
    fetch(cb) {
      const child = spawn(process.env.PYTHON || 'python', [path.join(__dirname, 'fetch_usage.py')], {
        windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HERMES_DB_PATHS: hermesDbCandidates().join(';') },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => cb({ ok: false, error: 'python 启动失败', hint: '需要安装 Python' }));
      child.on('close', () => {
        try { cb(JSON.parse(out.trim().split('\n').pop())); } catch (_) { cb({ ok: false, error: '数据解析失败' }); }
      });
    },
  },
  {
    id: 'dsh', name: 'DeepSeek Harness（网页版）', short: 'DSH', icon: '🌐', pricing: 'unknown',
    detect() {
      return exists(DSH_HOME) ? { found: true, detail: DSH_HOME + '（网页版会话数据）' } : { found: false, hint: '未找到 ' + DSH_HOME + ' 数据（需安装并启动过 DeepSeek Harness）' };
    },
    fetch(cb) {
      // 主路径：解码 ~/.dsh/sessions/**/session.jsonl.zstd（增量 + 分块让出事件循环，绝不阻塞主进程），
      // 按 assistant/message|chunk 的 usage（每步取最后一次）聚合，
      // 时间戳用事件自身 time（今天用量准确），模型来自 request/header（V4 flash / V4 PRO 拆分）
      (async () => {
        let records = [];
        if (hasZstd) records = await fetchDshSessionsAsync();
        if (!records.length) records = fetchDshProjcache();
        if (records.length) cb(aggregate(records));
        else cb({ ok: false, error: 'no_data', hint: '已安装，但暂无使用记录（本地无会话数据）' });
      })();
    },
  },
  {
    id: 'antigravity', name: '反重力 Antigravity', short: 'Antigravity', icon: '🪐', pricing: 'unknown',
    detect() {
      const dirs = [
        path.join(LOCAP, 'Programs', 'antigravity', 'Antigravity.exe'),
        path.join(LOCAP, 'Google', 'Antigravity', 'Antigravity.exe'),
        path.join(LOCAP, 'Programs', 'Antigravity', 'Antigravity.exe'),
      ];
      const hit = dirs.find(exists);
      if (hit) return { found: true, detail: hit };
      return { found: false, hint: '未找到 Antigravity.exe（残留的 ~/.antigravity 目录不算已安装）' };
    },
    fetch(cb) { cb({ ok: false, error: 'no_data', hint: 'Antigravity 用量存于私有数据库，暂无可读本地数据' }); },
  },
  {
    id: 'cursor', name: 'Cursor', short: 'Cursor', icon: '🖊️', pricing: 'unknown',
    detect() {
      const dirs = [path.join(LOCAP, 'Programs', 'cursor', 'Cursor.exe'), path.join(LOCAP, 'Programs', 'Cursor', 'Cursor.exe')];
      const hit = dirs.find(exists);
      return hit ? { found: true, detail: hit } : { found: false, hint: '未找到 Cursor.exe（残留配置不算已安装）' };
    },
    fetch(cb) { cb({ ok: false, error: 'no_data', hint: 'Cursor 用量存于私有数据库，暂无可读本地数据' }); },
  },
  {
    id: 'trae', name: 'Trae (TRACE)', short: 'Trae', icon: '🛰️', pricing: 'unknown',
    detect() {
      const dirs = [path.join(LOCAP, 'Programs', 'Trae', 'Trae.exe'), path.join(LOCAP, 'Programs', 'Trae CN', 'Trae.exe')];
      const hit = dirs.find(exists);
      return hit ? { found: true, detail: hit } : { found: false, hint: '未找到 Trae.exe' };
    },
    fetch(cb) { cb({ ok: false, error: 'no_data', hint: 'Trae 用量存于私有数据库，暂无可读本地数据' }); },
  },
  {
    id: 'madao', name: '华为云码道', short: '码道', icon: '☁️', pricing: 'unknown',
    detect() {
      let hit = null;
      try {
        const prog = path.join(LOCAP, 'Programs');
        if (exists(prog)) {
          const dir = fs.readdirSync(prog).find((n) => /codearts|madao|pangu|码道/i.test(n));
          if (dir) {
            const exe = fs.readdirSync(path.join(prog, dir)).find((n) => /\.exe$/i.test(n));
            if (exe) hit = path.join(prog, dir, exe);
          }
        }
      } catch (_) {}
      return hit ? { found: true, detail: hit } : { found: false, hint: '未找到华为云码道/CodeArts 可执行文件' };
    },
    fetch(cb) { cb({ ok: false, error: 'no_data', hint: '码道用量数据暂不可读' }); },
  },
  {
    id: 'copilot', name: 'GitHub Copilot', short: 'Copilot', icon: '👾', pricing: 'subscription',
    detect() {
      const vsc = path.join(LOCAP, 'Programs', 'Microsoft VS Code', 'Code.exe');
      const cop = path.join(ROAM, 'Code', 'User', 'globalStorage', 'github.copilot');
      return exists(vsc) && exists(cop) ? { found: true, detail: 'VS Code + Copilot 扩展' }
        : exists(vsc) ? { found: false, hint: '检测到 VS Code，但未找到 Copilot 扩展数据' }
        : { found: false, hint: '未找到 VS Code（Copilot 需要 VS Code）' };
    },
    fetch(cb) { cb({ ok: false, error: 'no_data', hint: 'Copilot 用量存于私有数据库，暂无可读本地数据' }); },
  },
];

module.exports = { AGENTS };
