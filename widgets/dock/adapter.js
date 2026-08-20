// 文件夹（快捷收纳）组件 —— Widgetly 主进程适配层
// 图标提取链 + items 管理 + 8 种排列 + 右键菜单；所有 IPC 按实例 ID 隔离
// 来源：F:\hermes-dock\main.js（已实测的完整链路）
const { ipcMain, app, Menu, dialog, shell, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

// 图标磁盘缓存（共享，重启秒开）
const ICON_CACHE_DIR = path.join(__dirname, '..', '..', 'icon-cache');
try { fs.mkdirSync(ICON_CACHE_DIR, { recursive: true }); } catch (_) {}

// 8 种排列对应的窗口尺寸（格子正方形、图标占格子 ~92%）
const LAYOUTS = {
  '3x3': { cols: 3, rows: 3, w: 204, h: 198, cell: 52, icon: 48 },
  '3x4': { cols: 3, rows: 4, w: 248, h: 320, cell: 68, icon: 62 },
  '4x2': { cols: 4, rows: 2, w: 280, h: 148, cell: 56, icon: 52 },
  '4x3': { cols: 4, rows: 3, w: 280, h: 210, cell: 56, icon: 52 },
  '4x4': { cols: 4, rows: 4, w: 280, h: 272, cell: 56, icon: 52 },
  '4x5': { cols: 4, rows: 5, w: 280, h: 334, cell: 56, icon: 52 },
  '5x4': { cols: 5, rows: 4, w: 284, h: 224, cell: 44, icon: 40 },
  '5x3': { cols: 5, rows: 3, w: 284, h: 174, cell: 44, icon: 40 },
};
const DEFAULTS = { bgOpacity: 0.4, layout: '4x2', pinned: false, locked: false, items: [] };

// ============ 图标提取链（实例无关，模块级共享） ============
function cacheKey(p) { return crypto.createHash('md5').update(String(p).toLowerCase()).digest('hex'); }
function readIconCache(p) {
  try {
    const f = path.join(ICON_CACHE_DIR, cacheKey(p) + '.png');
    if (fs.existsSync(f)) return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch (_) {}
  return null;
}
function writeIconCache(p, dataUrl) {
  try {
    const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(ICON_CACHE_DIR, cacheKey(p) + '.png'), Buffer.from(b64, 'base64'));
  } catch (_) {}
}

function lnkTargetJS(p) {
  try {
    const data = fs.readFileSync(p);
    if (data.length < 76 || data.readUInt32LE(0) !== 0x0000004C) return null;
    const flags = data.readUInt32LE(20);
    let pos = 76;
    if (flags & 0x01) { const sz = data.readUInt16LE(pos); pos += 2 + sz; }
    if (!(flags & 0x02)) return null;
    const liSize = data.readUInt32LE(pos);
    const li = data.subarray(pos, pos + liSize);
    if (li.length < 32) return null;
    const hdrSize = li.readUInt32LE(4);
    const linkFlags = li.readUInt32LE(8);
    const baseOff = li.readUInt32LE(16);
    const suffixOff = li.readUInt32LE(24);
    let unicodeOff = null;
    if (hdrSize >= 0x24) unicodeOff = li.readUInt32LE(28);
    let base = '';
    if ((linkFlags & 0x02) && unicodeOff && unicodeOff < li.length) {
      let end = li.indexOf(Buffer.from([0, 0]), unicodeOff);
      if (end > 0) base = li.subarray(unicodeOff, end).toString('utf16le');
    } else if (baseOff && baseOff < li.length) {
      let end = li.indexOf(0, baseOff);
      if (end > 0) base = li.subarray(baseOff, end).toString('latin1');
    }
    if (!base) return null;
    let sufOff = suffixOff;
    if ((linkFlags & 0x02) && hdrSize >= 0x28) {
      const s2 = li.readUInt32LE(32);
      if (s2) sufOff = s2;
    }
    if (sufOff && sufOff < li.length) {
      if (linkFlags & 0x02) {
        let end = li.indexOf(Buffer.from([0, 0]), sufOff);
        if (end > 0) {
          const suffix = li.subarray(sufOff, end).toString('utf16le');
          if (suffix && !base.toLowerCase().endsWith(suffix.toLowerCase())) base += suffix;
        }
      }
    }
    return base || null;
  } catch (_) { return null; }
}

function extractIconJS(p) {
  try {
    let exe = p;
    if (/\.lnk$/i.test(p)) {
      const t = lnkTargetJS(p);
      if (!t) return null;
      exe = t;
    }
    const buf = fs.readFileSync(exe);
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) return null;
    const peOff = buf.readUInt32LE(0x3C);
    if (buf.readUInt32LE(peOff) !== 0x00004550) return null;
    const numSections = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const optOff = peOff + 24;
    const magic = buf.readUInt16LE(optOff);
    const dirBase = optOff + (magic === 0x20B ? 112 : 96);
    const resDir = dirBase + 2 * 8;
    const resRVA = buf.readUInt32LE(resDir);
    if (!resRVA) return null;
    const sectOff = optOff + optSize;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const off = sectOff + i * 40;
      sections.push({
        vaddr: buf.readUInt32LE(off + 12),
        vsize: buf.readUInt32LE(off + 8),
        rawPtr: buf.readUInt32LE(off + 20),
        rawSize: buf.readUInt32LE(off + 16),
      });
    }
    const rvaToOff = (rva) => {
      for (const s of sections) {
        if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
          return s.rawPtr + (rva - s.vaddr);
        }
      }
      return null;
    };
    const readDir = (off) => {
      const n = buf.readUInt16LE(off + 12) + buf.readUInt16LE(off + 14);
      return { count: n, entriesOff: off + 16 };
    };
    const rootOff = rvaToOff(resRVA);
    if (!rootOff) return null;
    const root = readDir(rootOff);
    let iconDirOff = null;
    for (let i = 0; i < root.count; i++) {
      const e = root.entriesOff + i * 8;
      const id = buf.readUInt32LE(e);
      const offTo = buf.readUInt32LE(e + 4);
      if ((id & 0x80000000) === 0 && id === 3) {
        iconDirOff = rvaToOff(resRVA + (offTo & 0x7FFFFFFF));
        break;
      }
    }
    if (!iconDirOff) return null;
    const iconDir = readDir(iconDirOff);
    let best = null;
    const tryData = (langOff) => {
      const lang = readDir(langOff);
      for (let j = 0; j < lang.count; j++) {
        const le = lang.entriesOff + j * 8;
        const dOff = buf.readUInt32LE(le + 4);
        if (dOff & 0x80000000) continue;
        const deOff = rvaToOff(resRVA + dOff);
        if (!deOff) continue;
        const dataRva = buf.readUInt32LE(deOff);
        const dataSize = buf.readUInt32LE(deOff + 4);
        const dataOff = rvaToOff(dataRva);
        if (!dataOff) continue;
        const iconData = buf.subarray(dataOff, dataOff + dataSize);
        if (iconData.length <= 24) continue;
        if (iconData[0] === 0x89 && iconData[1] === 0x50) {
          const w = iconData.readUInt32BE(16);
          const h = iconData.readUInt32BE(20);
          if (!best || w * h > best.area) best = { area: w * h, data: iconData, isPng: true };
        } else if (iconData.readUInt32LE(0) === 40) {
          const w = iconData.readInt32LE(4);
          const hRaw = iconData.readInt32LE(8);
          const h = Math.abs(hRaw) / 2;
          if (w > 0 && h > 0 && (!best || w * h > best.area)) {
            best = { area: w * h, data: iconData, isPng: false };
          }
        }
      }
    };
    for (let i = 0; i < iconDir.count; i++) {
      const e = iconDir.entriesOff + i * 8;
      const offTo = buf.readUInt32LE(e + 4);
      if (offTo & 0x80000000) {
        const langOff = rvaToOff(resRVA + (offTo & 0x7FFFFFFF));
        if (langOff) tryData(langOff);
      } else {
        const deOff = rvaToOff(resRVA + offTo);
        if (deOff) tryData(deOff);
      }
    }
    return best ? (best.isPng ? 'data:image/png;base64,' + best.data.toString('base64')
                             : bmpToPng(best.data)) : null;
  } catch (_) { return null; }
}

function bmpToPng(data) {
  try {
    const w = data.readInt32LE(4);
    const hRaw = data.readInt32LE(8);
    const h = Math.abs(hRaw) / 2;
    const bpp = data.readUInt16LE(14);
    if (bpp !== 32 || w <= 0 || h <= 0) return null;
    const pixelBytes = w * h * 4;
    const raw = data.subarray(40, 40 + pixelBytes);
    const rgba = Buffer.alloc(pixelBytes);
    for (let i = 0; i < pixelBytes; i += 4) {
      rgba[i] = raw[i + 2]; rgba[i + 1] = raw[i + 1]; rgba[i + 2] = raw[i]; rgba[i + 3] = raw[i + 3];
    }
    // 自底向上 DIB（hRaw > 0）：缓冲行序从图像底部开始，必须垂直翻转，否则图标倒置
    if (hRaw > 0) {
      const row = w * 4;
      const tmp = Buffer.alloc(row);
      for (let y = 0; y < Math.floor(h / 2); y++) {
        const y2 = h - 1 - y;
        rgba.copy(tmp, 0, y * row, (y + 1) * row);
        rgba.copy(rgba, y * row, y2 * row, (y2 + 1) * row);
        tmp.copy(rgba, y2 * row);
      }
    }
    let alphaFull = true;
    for (let i = 3; i < pixelBytes; i += 4) { if (rgba[i] !== 255) { alphaFull = false; break; } }
    if (alphaFull) {
      const maskOff = 40 + pixelBytes;
      const maskRow = ((w + 31) >> 5) << 2;
      const mask = data.subarray(maskOff, maskOff + maskRow * h);
      if (mask.length >= maskRow * h) {
        for (let y = 0; y < h; y++) {
          // 掩码行序与 XOR 数据一致：自底向上时取对称行
          const sy = hRaw > 0 ? (h - 1 - y) : y;
          for (let x = 0; x < w; x++) {
            const byte = mask[sy * maskRow + (x >> 3)];
            rgba[y * w * 4 + x * 4 + 3] = ((byte >> (7 - (x & 7))) & 1) ? 255 : 0;
          }
        }
      }
    }
    const stride = w * 4;
    const rawRows = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      rawRows[y * (stride + 1)] = 0;
      rgba.copy(rawRows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(rawRows);
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    })();
    const crc32 = (buf2) => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < buf2.length; i++) c = crcTable[(c ^ buf2[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const chunk = (type, body) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    return 'data:image/png;base64,' + png.toString('base64');
  } catch (_) { return null; }
}

function iconViaPE(p) {
  return new Promise((resolve) => {
    if (/chrome|google/i.test(p)) { resolve(null); return; }
    setTimeout(() => resolve(extractIconJS(p)), 0);
  });
}

function iconViaPS(p) {
  return new Promise((resolve) => {
    const cs = `
using System;
using System.IO;
using System.Runtime.InteropServices;
public class ShellIcon256 {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint uStartScan, uint cScanLines, [Out] byte[] lpvBits, ref BITMAPINFO lpbmi, uint fuColorUse);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr ho);
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount; public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors0; }
  public static byte[] GetIconPng(string path, int size) {
    Guid riid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory f;
    IntPtr hbm = IntPtr.Zero;
    try {
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref riid, out f);
      SIZE s; s.cx = size; s.cy = size;
      f.GetImage(s, 0, out hbm);
      if (hbm == IntPtr.Zero) return null;
      var bmi = new BITMAPINFO();
      bmi.bmiHeader.biSize = 40; bmi.bmiHeader.biWidth = size; bmi.bmiHeader.biHeight = -size;
      bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32;
      byte[] bits = new byte[size * size * 4];
      IntPtr hdc = CreateCompatibleDC(IntPtr.Zero);
      int n = GetDIBits(hdc, hbm, 0, (uint)size, bits, ref bmi, 0);
      DeleteDC(hdc);
      if (n <= 0) return null;
      for (int i = 0; i < bits.Length; i += 4) {
        byte a = bits[i + 3];
        byte b = bits[i], g = bits[i + 1], r = bits[i + 2];
        if (a > 0 && a < 255) {
          r = (byte)Math.Min(255, r * 255 / a);
          g = (byte)Math.Min(255, g * 255 / a);
          b = (byte)Math.Min(255, b * 255 / a);
        }
        bits[i] = b; bits[i + 1] = g; bits[i + 2] = r; bits[i + 3] = a;
      }
      var bmp = new System.Drawing.Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
      var bd = bmp.LockBits(new System.Drawing.Rectangle(0, 0, size, size), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
      Marshal.Copy(bits, 0, bd.Scan0, bits.Length);
      bmp.UnlockBits(bd);
      using (var ms = new MemoryStream()) { bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png); return ms.ToArray(); }
    } catch { return null; }
    finally { if (hbm != IntPtr.Zero) DeleteObject(hbm); }
  }
}`;
    const script =
      `Add-Type -AssemblyName System.Drawing; ` +
      `Add-Type -TypeDefinition '${cs.replace(/'/g, "''")}' -ReferencedAssemblies System.Drawing; ` +
      `$bytes=[ShellIcon256]::GetIconPng('${p.replace(/'/g, "''")}',96); ` +
      `if($bytes){ Write-Output ([Convert]::ToBase64String($bytes)) }`;
    const ps = spawn('powershell', ['-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 8000 });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => resolve(null));
    ps.on('close', () => {
      const b64 = out.trim().split('\n').pop().trim();
      if (b64 && b64.length > 100) resolve('data:image/png;base64,' + b64);
      else resolve(null);
    });
  });
}

async function iconDataUrl(p) {
  try {
    const img = await app.getFileIcon(p, { size: 'large' });
    if (img.isEmpty()) return null;
    return img.toDataURL();
  } catch (_) { return null; }
}

// ============ 每实例适配 ============
function setup({ instance, win, save }) {
  const instId = instance.id;

  // 从实例配置读入（合并默认），之后用本地变量维护运行时状态
  const saved = { ...DEFAULTS, ...(instance.config || {}) };
  let items = Array.isArray(saved.items) ? saved.items.map((i) => ({ ...i })) : [];
  let layout = LAYOUTS[saved.layout] ? saved.layout : '4x2';
  let pinned = !!saved.pinned;
  let locked = !!saved.locked;
  // 0 也是用户可选的有效值（100% 透明）；此前用 > 0 判断会在重启后错误回退。
  let bgOpacity = (typeof saved.bgOpacity === 'number' && saved.bgOpacity >= 0 && saved.bgOpacity <= 1)
    ? saved.bgOpacity : DEFAULTS.bgOpacity;

  function capacity() { return LAYOUTS[layout].cols * LAYOUTS[layout].rows; }

  // 持久化：图标缓存 _icon 不写入 config.json
  function persist() {
    instance.config = { bgOpacity, layout, pinned, locked, items: items.map(({ _icon, ...rest }) => rest) };
    save();
  }

  function ensureVisible(x, y) {
    const L = LAYOUTS[layout];
    const rect = { x, y, width: L.w, height: L.h };
    for (const d of screen.getAllDisplays()) {
      const wa = d.workArea;
      const ix = Math.max(0, Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x));
      const iy = Math.max(0, Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y));
      if (ix * iy >= L.w * L.h * 0.15) return { x, y };
    }
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + Math.max(24, wa.width - L.w - 80), y: wa.y + 24 };
  }

  // ---------- items ----------
  function addPaths(paths) {
    let changed = false;
    for (const p of paths) {
      if (typeof p !== 'string' || !p) continue;
      if (items.some((it) => it.path.toLowerCase() === p.toLowerCase())) continue;
      if (items.length >= capacity()) break;
      const name = path.basename(p).replace(/\.(exe|lnk|bat|cmd|msi|url)$/i, '') || path.basename(p);
      items.push({ path: p, name: name.slice(0, 12) });
      changed = true;
    }
    if (changed) { persist(); pushItems(); }
  }
  async function addShortcuts() {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要添加的应用或文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '应用程序', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msi'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return;
    addPaths(r.filePaths);
  }
  async function removeShortcut(p) {
    items = items.filter((it) => it.path !== p);
    persist();
    await pushItems();
  }
  async function pushItems() {
    try {
      if (!win || win.isDestroyed()) return;
      const snapshot = () => items.map((it) => ({ ...it, icon: it._icon || readIconCache(it.path) || null }));
      win.webContents.send('items:' + instId, snapshot());
      await Promise.all(items.map(async (it) => {
        if (it._icon) return;
        const cached = readIconCache(it.path);
        if (cached) { it._icon = cached; return; }
        const pe = await iconViaPE(it.path);
        const icon = pe || (await iconViaPS(it.path)) || (await iconDataUrl(it.path));
        if (icon) { it._icon = icon; writeIconCache(it.path, icon); }
      }));
      if (!win || win.isDestroyed()) return;
      win.webContents.send('items:' + instId, snapshot());
    } catch (_) {}
  }

  // ---------- 排列切换（窗口高度渐变，无回跳） ----------
  function setLayout(l) {
    if (!LAYOUTS[l] || l === layout) return;
    const prevRows = LAYOUTS[layout].rows;
    layout = l;
    const L = LAYOUTS[l];
    const [x, y] = win.getPosition();
    const startH = win.getSize()[1];
    win.webContents.send('layout:' + instId, l, LAYOUTS[l].rows > prevRows ? 'down' : 'up');
    const steps = 10;
    (async () => {
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, 15));
        if (!win || win.isDestroyed()) return;
        win.setBounds({ x, y, width: L.w, height: Math.round(startH + (L.h - startH) * i / steps) });
      }
      persist();
      pushItems();
    })();
  }

  // ---------- 右键菜单（原生，与来源一致） ----------
  function showBlankMenu() {
    Menu.buildFromTemplate([
      { label: '添加快捷方式…', click: addShortcuts },
      { type: 'separator' },
      {
        label: '排列方式',
        submenu: [
          { label: '3×3 紧凑', type: 'radio', checked: layout === '3x3', click: () => setLayout('3x3') },
          { label: '3×4 竖版', type: 'radio', checked: layout === '3x4', click: () => setLayout('3x4') },
          { label: '4×2 矮横条', type: 'radio', checked: layout === '4x2', click: () => setLayout('4x2') },
          { label: '4×3 横版', type: 'radio', checked: layout === '4x3', click: () => setLayout('4x3') },
          { label: '4×4 高版', type: 'radio', checked: layout === '4x4', click: () => setLayout('4x4') },
          { label: '4×5 长版', type: 'radio', checked: layout === '4x5', click: () => setLayout('4x5') },
          { label: '5×4 大容量', type: 'radio', checked: layout === '5x4', click: () => setLayout('5x4') },
          { label: '5×3 大容量紧凑', type: 'radio', checked: layout === '5x3', click: () => setLayout('5x3') },
        ],
      },
      { type: 'separator' },
      { label: '置顶显示', type: 'checkbox', checked: pinned, click: () => togglePin() },
      { label: '锁定位置', type: 'checkbox', checked: locked, click: () => toggleLock() },
      { type: 'separator' },
      { label: '背景透明度…', click: () => win.webContents.send('show-opacity-panel:' + instId) },
      { type: 'separator' },
      { label: '退出此组件', click: quitWidget },
    ]).popup({ window: win });
  }
  function showGridMenu(p) {
    Menu.buildFromTemplate([
      { label: '打开', click: () => shell.openPath(p) },
      { label: '移除快捷方式', click: () => removeShortcut(p) },
    ]).popup({ window: win });
  }
  function togglePin() {
    pinned = !pinned;
    win.setAlwaysOnTop(pinned, 'floating');
    win.webContents.send('pin:' + instId, pinned);
    persist();
  }
  function toggleLock() {
    locked = !locked;
    win.webContents.send('lock:' + instId, locked);
    persist();
  }
  function quitWidget() {
    global.__cfg.instances = global.__cfg.instances.filter((i) => i.id !== instId);
    save();
    win.close();
  }

  // ---------- 初始尺寸：按当前排列校正（4x2 是 createWidgetWindow 的初始值，可能不符） ----------
  const L0 = LAYOUTS[layout];
  {
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    if (w !== L0.w || h !== L0.h) win.setBounds({ x, y, width: L0.w, height: L0.h });
  }
  // 恢复置顶状态（重启记忆）
  if (pinned) win.setAlwaysOnTop(true, 'floating');

  // ---------- IPC（按实例隔离） ----------
  ipcMain.on('launch:' + instId, (_e, p) => shell.openPath(p));
  ipcMain.on('add:' + instId, addShortcuts);
  ipcMain.on('add-files:' + instId, (_e, paths) => { if (Array.isArray(paths)) addPaths(paths); });
  ipcMain.on('save-bg-opacity:' + instId, (_e, v) => {
    bgOpacity = Math.max(0, Math.min(1, v));
    persist();
  });
  let ctxTarget = { type: 'blank' };
  ipcMain.on('ctx-target:' + instId, (_e, t) => { ctxTarget = t || { type: 'blank' }; });

  // 拖放：主进程原生事件 + 渲染层 HTML5 双通道（addPaths 去重幂等）
  win.webContents.on('drag-enter', () => win.webContents.send('drag-state:' + instId, true));
  win.webContents.on('drag-leave', () => win.webContents.send('drag-state:' + instId, false));
  win.webContents.on('drag-drop', (e, filePaths) => {
    e.preventDefault();
    win.webContents.send('drag-state:' + instId, false);
    if (Array.isArray(filePaths)) addPaths(filePaths);
  });

  // 右键菜单：图标右键=打开/移除；空白右键=全局菜单
  win.webContents.on('context-menu', () => {
    if (!win.isFocused()) win.focus();
    try {
      if (ctxTarget.type === 'grid') showGridMenu(ctxTarget.path);
      else showBlankMenu();
    } catch (_) {}
  });

  // 初始状态推送
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('pin:' + instId, pinned);
    win.webContents.send('lock:' + instId, locked);
    win.webContents.send('bg-opacity:' + instId, bgOpacity);
    win.webContents.send('layout:' + instId, layout, 'down');
    pushItems();
  });
}

module.exports = { setup, LAYOUTS };
