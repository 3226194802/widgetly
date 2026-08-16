// 主流 Agent 平台注册表 —— 检测安装 + 读取本地用量数据
// 数据来源（本地文件，无需网络/API）：
//   Hermes/DSH: state.db（fetch_usage.py）/ ~/.dsh/sessions（zstd 增量解码）
//   Claude Code: ~/.claude/projects/**/history.jsonl（total_cost_usd + usage tokens）
//   Codex: ~/.codex/sessions/**/*.jsonl（rollout，payload.response/event_msg 的 usage）
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
const dshPending = new Map();   // file -> {offset, model, steps} 上次超预算未解完的续解状态
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
  const tStart = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const out = zlib.zstdDecompressSync(b.subarray(f.start, f.end));
    for (const line of out.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { push(JSON.parse(line)); } catch (_) {}
    }
    // 每 8 帧让出一次事件循环（全量+增量统一）：zstd 同步解压会占满 CPU，
    // 必须高频让出，否则主进程拖动/右键菜单/托盘全部卡死（实测 20 分钟卡顿的根源）
    if ((i & 7) === 7) await yieldTurn();
    // 时间预算：单次解码超过 1.2 秒先暂停，剩余帧留下轮处理，避免长时间占用主进程
    if ((i & 63) === 63 && Date.now() - tStart > 1200 && i + 1 < frames.length) {
      try { fs.appendFileSync(path.join(HOME, '.dsh', 'widgetly-decode.log'), `[${new Date().toISOString()}] budget pause @ ${i}/${frames.length} of ${file}\n`); } catch (_) {}
      return { records: null, resumeOffsetAbs: base + frames[i + 1].start, model, steps, partial: true };
    }
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
    const pending = dshPending.get(f);
    // 未变化且无待续解 → 直接复用缓存（空闲轮询零开销）
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && !pending) {
      records.push(...cached.records);
      continue;
    }
    // 变化了 → 增量解码：有 pending 续解状态优先；否则文件变大时从缓存偏移续解
    let from = 0, model = 'dsh', steps = new Map();
    if (pending) { from = pending.offset; model = pending.model; steps = pending.steps; }
    else if (cached && st.size >= cached.size && cached.offset > 0) {
      from = cached.offset;
      model = cached.model || 'dsh';
      steps = cached.steps || new Map();
      if (from > st.size) { from = 0; model = 'dsh'; steps = new Map(); }
    }
    const res = await decodeDshFileRangeAsync(f, from, model, steps);
    if (res.partial) {
      // 超时间预算：记录续解状态，下轮继续；本文件暂不出结果
      dshPending.set(f, { offset: res.resumeOffsetAbs, model: res.model, steps: res.steps });
      continue;
    }
    dshPending.delete(f);
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

// 通用 jsonl 目录扫描（文件级缓存：mtime/size 未变的文件直接复用上次结果，30s 轮询零 IO；
// 每 8 个文件让出一次事件循环，首次扫描大目录也不阻塞主进程）
// extract(line, ctx) 返回 usage 记录或 null；ctx 携带本次扫描的跨行状态（去重等）
function createJsonlScanner(extract, onFileStart) {
  const fileCache = new Map();   // file -> { size, mtimeMs, records }
  return {
    async scan(dir) {
      const files = [];
      walkFiles(dir, (n) => n.endsWith('.jsonl'), files);
      const records = [];
      const ctx = { seen: new Set() };
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let st;
        try { st = fs.statSync(f); } catch (_) { continue; }
        const c = fileCache.get(f);
        if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) { records.push(...c.records); continue; }
        if (onFileStart) onFileStart();
        const recs = [];
        readJsonlLines(f, (line) => { const r = extract(line, ctx); if (r) recs.push(r); });
        fileCache.set(f, { size: st.size, mtimeMs: st.mtimeMs, records: recs });
        records.push(...recs);
        if ((i & 7) === 7) await yieldTurn();
      }
      return records;
    },
  };
}

// Claude Code：~/.claude/projects/**/*.jsonl
// assistant 行：message.model / message.usage(input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens) / timestamp（ISO 字符串）。实测 v2.1.x 有两个坑：
//   1) 同一回复写两行（thinking 与 text 拆行、message.id 相同、usage 相同）→ 按 message.id 去重；
//   2) 无 total_cost_usd 字段 → 费用显示为「—」（pricing: unknown）
// summary 行是对旧消息的摘要合并，计入会重复计算，故仅统计 type==='assistant'
const claudeScanner = createJsonlScanner((line, ctx) => {
  if (!line || line.type !== 'assistant' || !line.message || !line.message.usage) return null;
  if (line.message.model === '<synthetic>') return null;   // Claude Code 内部占位，非真实模型
  const mid = line.message.id;
  if (mid) { if (ctx.seen.has(mid)) return null; ctx.seen.add(mid); }
  const u = line.message.usage;
  const ts = Date.parse(line.timestamp || '');
  if (!ts || isNaN(ts)) return null;
  return {
    ts, model: line.message.model || 'claude',
    input: u.input_tokens || 0, output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    reasoning: 0, cost: typeof line.total_cost_usd === 'number' ? line.total_cost_usd : 0,
  };
});

// Codex：~/.codex/sessions/**/*.jsonl（rollout 文件）
// 实测新格式：token_count 事件 → info.last_token_usage 为增量（每个 rollout 文件独立计数，
// 全部事件求和 = 真实用量；info.total_token_usage 是会话累计，求和会重复统计）。
// 相邻重复事件（同一累计值被写两次）按 total_token_usage 去重。
// 口径归一：Codex 的 input_tokens 已含 cached_input_tokens、output_tokens 已含
// reasoning_output_tokens（与 DSH/Claude 的分列口径不同），拆开后与其它平台一致相加。
// 兼容旧格式：response_item.response.usage / event_msg.payload.usage
let codexModel = null, codexLastTotal = null;
const codexScanner = createJsonlScanner((line) => {
  if (!line) return null;
  const pl = line.payload || {};
  if (pl.response && pl.response.model) codexModel = pl.response.model;
  if (pl.type === 'event_msg' && pl.payload && pl.payload.model) codexModel = pl.payload.model;
  const norm = (u) => ({
    ts: Date.parse(line.timestamp || ''),
    model: codexModel || 'codex',
    input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)),
    output: Math.max(0, (u.output_tokens || 0) - (u.reasoning_output_tokens || 0)),
    cacheRead: u.cached_input_tokens || 0,
    cacheWrite: u.cache_write_input_tokens || 0,
    reasoning: u.reasoning_output_tokens || 0,
    cost: 0,
  });
  if (pl.type === 'token_count' && pl.info && pl.info.last_token_usage) {
    const u = pl.info.last_token_usage;
    const tot = pl.info.total_token_usage || {};
    const key = [tot.input_tokens, tot.cached_input_tokens, tot.output_tokens, tot.reasoning_output_tokens].join(',');
    if (key === codexLastTotal) return null;   // 重复事件
    codexLastTotal = key;
    const r = norm(u);
    if (!r.ts || isNaN(r.ts)) return null;
    return r;
  }
  let usage = null;
  if (pl.type === 'response_item' && pl.response && pl.response.usage) usage = pl.response.usage;
  if (pl.type === 'event_msg' && pl.payload && pl.payload.usage) usage = pl.payload.usage;
  if (!usage) return null;
  const cached = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || usage.input_tokens_cache_read || 0;
  const reasoning = (usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) || 0;
  const ts = Date.parse(line.timestamp || '');
  if (!ts || isNaN(ts)) return null;
  return {
    ts, model: codexModel || 'codex',
    input: Math.max(0, (usage.input_tokens || 0) - cached),
    output: Math.max(0, (usage.output_tokens || 0) - reasoning),
    cacheRead: cached, cacheWrite: usage.input_tokens_cache_write || 0,
    reasoning, cost: 0,
  };
}, () => { codexModel = null; codexLastTotal = null; });

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
      let out = '', done = false;
      // 8 秒保险丝：杀软拦截等导致子进程挂起时，超时杀掉并释放 fetchBusy（否则轮询永久停摆）
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        if (!done) { done = true; cb({ ok: false, error: 'timeout', hint: 'Python 读取超时（8 秒），可能被杀毒软件拦截' }); }
      }, 8000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); cb({ ok: false, error: 'python 启动失败', hint: '需要安装 Python' }); } });
      child.on('close', () => {
        if (done) return;
        done = true; clearTimeout(timer);
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
    id: 'claude', name: 'Claude Code（命令行）', short: 'Claude Code', icon: '✳️', pricing: 'unknown',
    detect() {
      const dir = path.join(HOME, '.claude', 'projects');
      return exists(dir) ? { found: true, detail: dir } : { found: false, hint: '未找到 ~/.claude/projects（需安装并运行过 Claude Code CLI）' };
    },
    fetch(cb) {
      (async () => {
        try {
          const records = await claudeScanner.scan(path.join(HOME, '.claude', 'projects'));
          if (records.length) cb(aggregate(records));
          else cb({ ok: false, error: 'no_data', hint: '已安装 Claude Code，但本地暂无会话用量记录' });
        } catch (e) { cb({ ok: false, error: 'fetch_error', hint: String((e && e.message) || e) }); }
      })();
    },
  },
  {
    id: 'codex', name: 'OpenAI Codex（命令行）', short: 'Codex', icon: '🤖', pricing: 'subscription',
    detect() {
      const dir = path.join(HOME, '.codex', 'sessions');
      return exists(dir) ? { found: true, detail: dir } : { found: false, hint: '未找到 ~/.codex/sessions（需安装并运行过 Codex CLI）' };
    },
    fetch(cb) {
      (async () => {
        try {
          const records = await codexScanner.scan(path.join(HOME, '.codex', 'sessions'));
          if (records.length) cb(aggregate(records));
          else cb({ ok: false, error: 'no_data', hint: '已安装 Codex，但本地暂无会话用量记录' });
        } catch (e) { cb({ ok: false, error: 'fetch_error', hint: String((e && e.message) || e) }); }
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

module.exports = { AGENTS, hasPendingDsh: () => dshPending.size > 0 };
