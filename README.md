# Widgetly 组件坞

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Windows 桌面小组件中心 —— 一个管理器 + 多种透明置顶小组件,极简 iOS 风格,本地运行、无需联网、无服务器。

## 功能

- **组件坞(管理器)**:macOS 小组件画廊风格,深色毛玻璃 + 左侧分类导航 + 原始尺寸预览,支持拖动排序、搜索;
- **灵动时钟**(标准/中/小):渐变数字、12/24 小时制、背景透明度、4 个数字独立配色;
- **日历**系列:今日脉搏 / 胶囊日期 / 青柠 / 月相月历 / 周环 / 墨滴月历 / 全景,共 8 种形态,含农历;
- **弹力文件夹**:应用/文件快捷收纳,8 种排列;
- **图库**:本地文件夹轮播(无缝交叉淡化);
- **今日待办** / **番茄时钟**:每日待办、番茄专注计时(重启续跑);
- **AI 用量监控**:本地读取 Agent 桌面软件的 token 用量(Hermes / DeepSeek Harness);
- **内存监控**:实时内存心电图 + 磁盘占用;
- **DSH 启动器**:一键启动 DeepSeek Harness;
- 每个组件都支持:右键菜单、锁定位置、置顶、透明度、退出,并持久化到本地配置。

## 运行要求

- Windows 10 / 11(x64)
- 无需安装 Python(仅 AI 用量监控的 Hermes 平台需要 Python)

## 开发运行

```bash
npm install
npm start
```

## 打包发布

```bash
# 生成安装版(NSIS .exe)+ 便携版(.exe),输出到 dist/
npm run build

# 只生成便携版
npm run build:portable
```

## 目录结构

```
Widgetly/
├── main.js              # 主进程(窗口管理/托盘/拖动/配置)
├── manager/             # 组件坞(管理器)界面
├── widgets/             # 各组件(clock/dock/gallery/todo/calendar/...)
│   └── monitor/         # AI 用量监控(多 Agent 平台)
├── assets/              # 应用图标
└── config.json          # 用户实例配置
```

## 发布与在线更新

- 应用内置**在线更新**:用户在设置里点"检查更新"即可自动升级(基于 GitHub Releases,无需服务器);
- 发布流程见 [PUBLISH_GUIDE.md](./PUBLISH_GUIDE.md)(零基础傻瓜教程,网页上点几下即可发新版);
- 构建产物:`Widgetly-Setup-*.exe`(安装版,支持自动更新)、`Widgetly-Portable-*.exe`(便携版)、`latest.yml`(更新清单,发布时需一并上传)。

## 许可

本项目采用 [MIT License](./LICENSE) 开源。你可以自由使用、修改、商用、再分发，但需保留版权声明。

## 技术栈

Electron 40 · 原生 Node(零前端框架)· koffi(Win32 互操作)· backdrop-filter 实时毛玻璃
