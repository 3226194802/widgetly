# Widgetly 组件坞 —— 项目交接文档

> 给接手的 AI：这是一份完整的项目现状说明，包含架构、已完成功能、本机环境、已踩坑清单和待办事项。请先通读全文再动手。

---

## 一、项目目标

把 3 个现有的 Windows 桌面小组件整合成一个应用 **Widgetly（组件坞）**：
- 单进程管理：管理器窗口 + 组件窗口（多实例）+ 系统托盘
- 管理器界面：**macOS Widget Gallery 风格**——深色毛玻璃主窗口 + 白色卡片式组件预览（参考 iOS 小组件画廊）
- 动画是重点要求（spring 曲线、错峰入场、hover 上浮、点击弹跳）
- 商业路线：先免费发布 GitHub 起量 → 后续 Pro 收费（已和用户确认）

## 二、目录结构

```
<项目目录>\
├── main.js                 # 主进程（核心，9000+ 字，已成型）
├── config.json             # 实例配置（用户当前只有 clock-1 一个实例）
├── manager\                # 管理器界面（已成型）
│   ├── index.html
│   ├── style.css
│   └── renderer.js
├── widgets\                # 组件库（组件注册表 + 每个组件一个目录）
│   ├── clock\              # ✅ 已迁移（渐变时钟，含字体文件）
│   │   ├── index.html / style.css / renderer.js
│   │   ├── SF-Pro-Rounded-Heavy.otf / SF-Pro-Rounded-Black.otf
│   │   └── Nunito-ExtraBold.woff2
│   ├── dock\               # ⏳ 占位页（待迁移，来源 F:\hermes-dock）
│   └── monitor\            # ⏳ 占位页（待迁移，来源 F:\hermes-widget）
└── widgetly-debug.log      # 运行日志（排障用）
```

## 三、三个现有组件（迁移来源，都在独立运行）

| 组件 | 目录 | 关键特征 |
|---|---|---|
| 渐变时钟 | F:\gradient-clock | SF Pro Rounded Heavy 大数字、±3°交替倾斜、60%圆点、毛玻璃（glass壁纸层+veil白罩）、HTML 自定义右键菜单（12/24制、深浅色、自绘透明度滑杆、复制时间） |
| 快捷收纳 | F:\hermes-dock | 8 种排列（3x3/3x4/4x2/4x3/4x4/4x5/5x4/5x3）+窗口高度渐变+网格滑动动画、图标提取链（见坑12）、图标磁盘缓存、毛玻璃背景、整卡右键、整卡自定义拖动（移动>5px才拖，点击打开应用） |
| AI 用量监控 | F:\hermes-widget | iOS 18 WidgetKit 风（白毛玻璃、环形图、2x2指标、会话排行进度条带发光）、数据源 = Hermes 的 state.db（session_model_usage 表） |

**注意**：这三个独立组件仍然在用户桌面上正常运行，**不要停掉它们**。Widgetly 是并行开发的新应用。

## 四、Widgetly 主进程架构（main.js 已实现）

1. **组件注册表**：
```js
const WIDGETS = {
  clock: { id, name: '灵动时钟', icon: '⏰', w: 284, h: 150, entry: 'index.html' },
  dock:  { id, name: '文件夹', icon: '🗂️', w: 280, h: 148, entry: 'index.html' },
  monitor: { id, name: 'AI 用量监控（Hermes）', icon: '📊', w: 342, h: 500, entry: 'index.html' },
};
const WIDGET_DEFAULTS = {  // 默认配置，实例配置为空时合并（修复数字变 NaN 的坑）
  clock: { width: 284, theme: 'auto', subtitle: 'iScreen', hour12: false, showSubtitle: true, veilOpacity: 32, gradientOrder: 'abab', glass: true },
  dock: { bgOpacity: 0.92, layout: '4x2', pinned: false },
  monitor: { bgOpacity: 0.66, pinned: false },
};
```

2. **组件窗口工厂** `createWidgetWindow(instance)`：
   - 透明窗口（transparent/resizable:false/skipTaskbar/hasShadow:false）
   - `loadFile(..., { query: { inst: instance.id } })` —— **实例 ID 通过 URL query 传给组件**
   - 注册每实例 IPC：`cfg:${id}`（返回默认+实例配置合并）、`cfg:save:${id}`、`resize:${id}`

3. **共享引擎**（三个组件公用的能力，已内建）：
   - **壁纸**：启动时截一次屏（desktopCapturer，JPEG q80），`wallpaper` / `wallpaper-pos` 通道按窗口位置发坐标
   - **拖动**：`drag-start` / `drag-end` 通道——main 16ms 轮询 cursor + `setBounds`（**必须固定宽高**，坑 4）
   - **activate**：窗口聚焦（右键菜单前置，坑 8）
   - **evt**：组件事件日志 → widgetly-debug.log

4. **管理器 IPC**：`widgets-list`（组件清单+实例数）、`instances-list`、`add-widget`、`remove-widget`、`toggle-widget`、`manager-close`、`quit-app`

5. **托盘**：click 打开管理器，右键菜单（打开/退出）

6. **启动顺序**：whenReady → `global.__cfg = loadConfig()`（**screen 模块必须 ready 后使用，坑 14**）→ captureWallpaper → 管理器 + 托盘 + 启动所有实例

## 五、管理器界面（已成型）

- 深色毛玻璃：`rgba(28,28,34,0.88)` + blur(30px)、26px 圆角、入场 scale 动画
- 顶栏（W 图标 + Widgetly 组件坞 + 关闭/退出按钮，可拖动窗口）
- 导航：仅一个「全部」tab + 滑动指示器胶囊
- **组件预览网格**：4 列 `repeat(4,1fr)` + `grid-auto-flow: dense` + gap 16px
  - 尺寸 class：`.widget-1x1`(130h) / `.widget-2x1`(148h) / `.widget-2x2`(312h) / `.widget-4x2`(312h 预留)
  - 映射：clock/dock → 2x1；monitor → 2x2
  - **预览 = iframe 实时渲染组件真实界面**（时钟在预览里真的走）
  - iframe 关键实现（坑 15）：`position:absolute; left:0; top:0; transform-origin: top left`，尺寸=组件实际尺寸，JS 计算 `scale = min(boxW/w, boxH/h)` 缩放填充——**绝不能把 iframe 视口设成容器大小**（会只显示中心部分）
- 白底卡片：94% 白、16px 圆角、双层软阴影、hover 上浮
- 名称：SF Pro Rounded Heavy 800（@font-face 引用 `../widgets/clock/SF-Pro-Rounded-Heavy.otf`）
- 动画：卡片错峰上浮（stagger 70-90ms）、hover translateY(-4px)、点击弹跳

## 六、组件适配模板（迁移组件时按此改）

组件 renderer 需要做的适配：
```js
// 1. 从 query 取实例 ID
const instId = new URLSearchParams(location.search).get('inst') || 'clock-1';
// 2. 配置通道按实例隔离 + 预览模式 fallback
let cfg;
try { cfg = await ipcRenderer.invoke('cfg:' + instId); }
catch (_) { cfg = { /* 组件默认配置 */ }; }
// 3. 保存配置
ipcRenderer.send('cfg:save:' + instId, prefs);
// 4. 壁纸（通用通道，直接用）
applyWallpaper(await ipcRenderer.invoke('wallpaper'));
ipcRenderer.on('wallpaper', (e, wp) => applyWallpaper(wp));
ipcRenderer.on('wallpaper-pos', (e, p) => { ... });
// 5. 拖动（通用通道）
mousedown(左键) → ipcRenderer.send('drag-start')
mouseup/blur → ipcRenderer.send('drag-end')
// 6. 右键前先激活
ipcRenderer.send('activate');
// 7. 窗口尺寸变化（如 dock 排列切换）
ipcRenderer.send('resize:' + instId, { width, height });
```

## 七、本机环境

- **Electron**：`<path>\node_modules\electron\dist\electron.exe`（v40.10.2）
- 运行：`electron.exe <项目目录>`
- 系统：Windows 11 25H2 (build 26220)，150% DPI
- 硬件加速：**必须 `app.disableHardwareAcceleration()`**（GPU 合成有各种怪问题）
- 调试：启动参数加 `--remote-debugging-port=9224`，用 CDP 验证（ws 库在 node_modules 里）
- 识图：`node "<path>/vision.js" "<图片路径>" "<问题>"`（qwen-vl-max，中文提问）

## 八、已踩坑清单（全部实测，极其重要）

1. **透明窗口 + 全透明页面不 commit** → surface 永远空白。页面必须有完全不透明内容（组件都用"glass 壁纸层"保证）
2. **desktopCapturer 调用后透明窗口合成被破坏**（窗口从屏幕消失）→ 壁纸只在窗口创建前截一次，之后只重算位置
3. **hide/show 会把窗口踢出屏幕合成** → 避免运行时 hide 组件窗口
4. **transparent + resizable:false 窗口连续 setPosition 每帧宽度 +1px 累积** → 拖动必须 `setBounds({x,y,width,height})` 每帧固定宽高
5. `nativeImage.getSize()` 返回 `{width,height}` 对象（不是数组）；`toJPEG()` 返回 Buffer（需 toString('base64')）
6. resizable:false 时 `setSize` 失效 → 用 setBounds
7. `-webkit-app-region: drag` 区域右键 = Windows 系统菜单（无法拦截）→ 组件都用"整卡 no-drag + 自定义拖动（main 轮询）"方案
8. **未激活窗口 contextmenu 不触发** → 右键前先 `ipcRenderer.send('activate')`，main 里 win.focus()
9. PrintWindow / desktopCapturer 全屏截图**抓不到普通文本层**（渐变数字能抓到是因为背景绘制）→ 视觉验证用 CDP `Page.captureScreenshot`
10. 原生 range input 的 thumb 在本机拖不动 → 透明度滑杆要自绘（div 版）
11. `background-clip:text` + 固定窄盒 → 字形超出盒子部分无渐变被"切掉" → 数字容器 `width: auto`
12. **图标提取**（dock 的完整链）：PE32 数据目录基址 = optOff+96，PE32+ = +112（按 Magic 0x10B/0x20B 判断）；Chrome 的 PE 资源会取到隐私模式图标 → 强制走系统提取；UWP 应用（哔哩哔哩）lnk 无目标路径；系统提取 = PowerShell + C# IShellItemImageFactory（Add-Type 需 `-ReferencedAssemblies System.Drawing`；SIIGBF_THUMBNAILONLY 对 lnk 无效；尺寸 96 足够）；**GetImage 的 HBITMAP 是 premultiplied BGRA，必须保持 BGRA 序写入 Bitmap**（转 RGBA 会导致 R/B 互换，哔哩红色变紫色）
13. 屏幕遮挡源：Hermes（置顶全屏）、Windows 输入体验（语音输入时全屏）、护眼宝、任务切换 → 组件被盖时 occluded 不渲染，验证组件效果时要置顶或 Win+D
14. **screen 模块必须 app ready 后使用**（组件坞的 defaultConfig 曾因此在启动时崩溃）
15. **管理器 iframe 预览**：iframe 必须"尺寸=组件实际尺寸 + absolute 左上角原点 scale"，否则只显示中心部分或偏移
16. CSS `rgba(var(--c), var(--a))` 变量展开在本机失效 → 用 `opacity: var(--a)` + 独立颜色变量
17. 开机自启：注册表 HKCU Run 键直启 electron（比启动文件夹早，用户已使用此方案于旧组件）
18. 组件窗口关闭/杀进程：taskkill 按 PID 精确杀，`taskkill /IM electron.exe` 会误杀所有组件

## 九、用户偏好（做设计/交互必读）

- **微调粒度**：用户会要求"第 N 位数字左移 Npx、角度 ±N°"——严格按字面改，**不要动没要求的部分**（用户对"整体缩放/改了别的"明确不满过）
- 设置必须持久化（重启记忆）；"不生效"先自证（CDP + 像素对比），**不要猜**；拿不准就埋日志（evt 通道已就绪）
- 动画要求高：spring 曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)`、200-400ms、错峰、不拖沓
- 风格：iOS 极简、白色毛玻璃卡片、大圆角、软阴影
- 组件默认不置顶（Win+D 看桌面）
- 用户按屏幕位置称呼组件（最上渐变时钟="第一个组件"、dock="第二个快捷方式组件"）
- 字体：SF Pro Rounded Heavy（自用）；**发布版必须换 Nunito**（Apple 字体许可禁止再分发）+ 组件内 "iScreen" 文案要改（商标）
- 组件命名（用户指定）：灵动时钟 / 文件夹 / AI 用量监控（Hermes）

## 十、待办（下一步工作，按顺序）

1. **迁移 dock 到 widgets/dock**：
   - 图标提取链（PE32/32+ 分支、IShellItemImageFactory、缓存）建议抽到 `shared/icons.js` 共享模块
   - dock 的 main 侧逻辑（items 管理、launch/add/remove、8 种排列 setBounds、菜单）→ 组件适配层（IPC 全部加 `:${instId}` 后缀）
   - renderer 按第六节模板适配（instId、cfg 通道、resize 通道）
2. **迁移 monitor 到 widgets/monitor**：
   - state.db 读取逻辑 → 组件适配层（数据推送 IPC）
   - 注意 db 路径：`<hermes 目录>\profiles\code\state.db`（session_model_usage 表）
3. **全流程测试**：管理器添加/删除/切换三组件；多实例并存
4. **阶段 2**（动效打磨）：添加组件时"管理器卡片弹跳 + 桌面窗口 pop-in 联动"动画
5. **阶段 3**：多实例管理 UI、拖拽排序、组件设置面板、深/浅色主题
6. **阶段 4 发布**：字体换 Nunito、应用图标、electron-builder 打包、GitHub Releases

## 十一、当前已知状态

- config.json 里只有 `clock-1` 一个实例（用户正式使用的，位置 977,200）
- dock/monitor 的 widgets 目录是"🚧 迁移中"占位页（点添加会显示占位）
- 管理器添加时钟实例已验证：数字大小正常（默认配置合并修复）、右键菜单正常（activate 修复）
- 拖动功能：renderer 逻辑完整 + main 共享引擎已注册；若用户再报"拖不动"，读 `<项目目录>\widgetly-debug.log` 定位（日志通道已埋好）
