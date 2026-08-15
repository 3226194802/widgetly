# Widgetly 微软商店上架清单

> 按顺序执行。标注 ⚠️ 的是上架前必须处理的事项。

## 0. 前置条件

- [ ] 一个 Microsoft 账号(开发者账号,现已免注册费)
- [ ] 在 [合作伙伴中心](https://partner.microsoft.com/) 完成开发者注册
- [ ] 预留一个**应用名称**(商店里要唯一)

## 1. ⚠️ 上架前必须处理的事项

| 问题 | 影响 | 状态 |
|---|---|---|
| config.json 在打包后位于只读的 app.asar 内 | 打包后无法保存配置 | ✅ **已修复**：配置已移到 `%APPDATA%\Widgetly\config.json`（可写），旧目录配置自动迁移 |
| SF Pro 字体文件残留（Apple 版权） | 审核/法律风险 | ✅ **已删除**，已全量换成 Open Runde |
| 托盘图标（原来为空图标） | 用户看不到托盘 | ✅ **已换正式图标** |
| koffi 原生模块在 MSIX 容器内 | 可能加载失败 | ⬜ 打包后实测 SetWindowRgn 圆角、固定层级（WorkerW）两个功能 |
| 开机自启用 reg/schtasks/PowerShell | 商店对自启较敏感 | ⬜ 保留，但准备在隐私说明里写清用途 |

## 2. 打包

```bash
npm install
npm run build        # 生成 dist/Widgetly Setup x.x.x.exe(NSIS)+ 便携版
```

- 验证安装包能正常安装、启动、保存配置、托盘图标显示。
- 图标已配置在 `assets/icon.png`(electron-builder 会自动生成 .ico)。

## 3. 制作 MSIX(商店用)

推荐两条路二选一:

**A. 微软 MSIX Packaging Tool(最简单)**
1. 商店里免费下载 [MSIX Packaging Tool](https://learn.microsoft.com/windows/msix/packaging-tool/)。
2. 用它对 `dist/` 里的 NSIS 安装包打包成 `.msix`。
3. 按向导填:包名、发布者(你的 Publisher ID)、版本、图标(用 `assets/icon.png`)。

**B. electron-builder 的 appx 目标**
在 `package.json` 的 `build` 里加 `appx` 配置(需要你的 Publisher ID,可在合作伙伴中心 → 应用标识里查到)。

## 4. 提交商店

在合作伙伴中心 → 新建应用 → 填写:

- [ ] **应用名称**:与预留的一致
- [ ] **支持信息**:描述、截图(至少 1 张 1366×768 的界面截图,推荐 3-5 张)
- [ ] **图标**:用 `assets/icon.png`(或导出的 .ico)
- [ ] **类别**:工具 / 效率
- [ ] **定价**:免费(或你决定)
- [ ] **隐私声明 URL**:需要一个可访问的网页(可用 GitHub Pages 挂一个简单的隐私声明)
- [ ] **年龄分级**:填写问卷(工具类一般低龄级)

## 5. 提交后

- 审核通常 1-3 个工作日;
- 被驳回会给出具体原因(常见:图标尺寸不符、隐私声明缺失、自启需说明);
- 通过后,更新走商店的自动更新,无需自建更新服务器。

## 6. 双轨分发建议

- **微软商店**:面向普通用户(自动更新 + 签名 + 信任);
- **GitHub Releases**:面向技术用户/便携版(`npm run build` 产物直接上传);
- 代码可保持**闭源**(商店不强制开源)。
