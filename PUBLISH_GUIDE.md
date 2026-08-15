# 发布到 GitHub + 在线更新 —— 零基础傻瓜教程

> 全程只需要点鼠标,不需要会编程。第一次总共约 30 分钟,以后每次发新版约 2 分钟。

---

## 一、第一次:注册 GitHub 账号(约 5 分钟)

1. 打开 https://github.com ,点右上角 **Sign up**;
2. 填邮箱 → 设置密码 → 起一个**用户名**(记下来!后面要用,比如 `xiaowang`)→ 完成邮箱验证;
3. 注册完你就是有账号的人了。

## 二、第一次:把软件上传到 GitHub(约 15 分钟)

1. 打开 https://desktop.github.com ,下载并安装 **GitHub Desktop**,登录你的账号;
2. 打开 GitHub Desktop → 菜单 **File → Add local repository...**;
3. 路径选 `F:\Widgetly` → 如果提示 "This directory does not appear to be a Git repository",点 **create a repository**;
4. 名称填 `widgetly` → **Create repository**;
5. 点右上角 **Publish repository** → **取消勾选 "Keep this code private"**(公开仓库构建免费)→ **Publish repository**。

## 三、第一次:改一处配置(约 1 分钟)

1. 用记事本打开 `F:\Widgetly\package.json`;
2. 找到 `"owner": "YOUR_GITHUB_USERNAME"`;
3. 把 `YOUR_GITHUB_USERNAME` 换成**第一步注册的用户名**(比如 `xiaowang`),保存;
4. 回到 GitHub Desktop,看到 package.json 有改动 → 左下角填个说明(如"改配置")→ 点 **Commit to main** → 点 **Push origin**。

## 四、以后每次发新版(约 2 分钟,全在网页上点)

1. 打开 https://github.com/你的用户名/widgetly → 顶部点 **Actions**;
2. 左侧点 **Build & Release** → 右侧点 **Run workflow**;
3. 输入新版本号(比如 `0.3.0`,每次比上次大一点)→ 点绿色 **Run workflow**;
4. 等 5-10 分钟(黄色转绿 ✓),构建完成;
5. 你的用户打开软件 → 设置 → **检查更新**,就会自动下载安装新版本。✅

---

## 五、我帮你做的三件事里,还剩两件需要你提供信息

### 1. 微信收款码(你只要截个图给我)

1. 打开**手机微信** → 右下角 **我** → **服务** → **收付款** → **二维码收款**;
2. 点 **保存收款码**(或直接截图);
3. 把图片传到电脑(微信"文件传输助手"发给"文件传输助手",或 QQ 发给自己),**存到桌面**,文件名随便;
4. 告诉我:"收款码在桌面上,叫 xxx.png",我帮你放进软件里。

### 2. QQ 群号 + QQ 号(你只要打一行字给我)

直接回复我,例如:
> QQ群号:888888888
> QQ号:123456789

我帮你填进设置页面。
