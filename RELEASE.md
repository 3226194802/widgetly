# Widgetly 更新机制说明（防魔改 + 双仓库策略）

> 这份文档说明「更新怎么让用户方便」「怎么防魔改」，是《PUBLISH_GUIDE.md》（零基础图文教程）和 `release.ps1`（一键发布脚本）的补充。日常发版照 PUBLISH_GUIDE 或 release.ps1 做即可。

---

## 一、用户如何更新（两种方式并存）

1. **软件内一键更新**：用户打开「设置 → 检查更新」，检测到新版 → 点「立即更新」→ 下载 → 重启自动装好。由 `electron-updater` 驱动（`main.js` 的 `initUpdater()`），`latest.yml` 带 sha512 完整性校验，中途被换包会自动拒绝。
2. **浏览器手动下载**：设置页新增「🌐 打开下载页」按钮，用默认浏览器打开 GitHub Releases，用户自己下载 exe 安装。

## 二、防魔改（三件事）

1. **代码签名证书**（推荐 OV，几百元/年）：别人改了你的 exe，签名即失效，Windows 弹「签名无效」警告，更新器也会因 sha512 校验失败而拒绝。**这是最有效的一层，建议下一版购买。**
2. **更新器完整性校验**：已内置（sha512），免费。
3. **官方渠道引导**：让用户只从官网/GitHub/商店下载，别从第三方网盘下。

## 三、双仓库策略（防抄袭换皮）

| 仓库 | 可见性 | 放什么 |
|---|---|---|
| `widgetly`（源码） | **私有** | 全部源码 |
| `widgetly-releases`（发布） | **公开** | 只放 Release 安装包 + latest.yml |

- 源码放私有仓库，别人 fork 不走、看不到代码。
- 公开仓库只放安装包，用户能下载能更新，但拿不到源码。
- 之所以分开：GitHub Release 必须公开，`electron-updater` 才能免登录拉取；私有仓库拉 Release 需带 token（写进软件会泄露）。

## 四、不买证书这一版的取舍

- 能正常用软件内更新、浏览器下载、完整性校验。
- 用户双击安装包会弹 SmartScreen「未知发布者」警告，点「仍要运行」即可。
- **注意**：下一版换成签名 exe 后，`latest.yml` 的 sha512 变化，老用户自动更新会校验失败，需让他们去下载页手动重装一次。这是「先无证后有证」的代价。

## 五、配置占位符（待填真实用户名）

`package.json` 两处 + `main.js` 一处，`YOUR_GITHUB_USERNAME` 换成你的 GitHub 用户名：

- `package.json` → `repository.url`
- `package.json` → `build.publish.owner`（`repo` 填 `widgetly-releases`）
- `main.js` → `RELEASE_URL`
