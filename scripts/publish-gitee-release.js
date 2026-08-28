// 将已构建的 Windows 安装包发布到 Gitee Release。
// 使用方式：在当前终端临时设置 GITEE_TOKEN 后运行：
// node scripts/publish-gitee-release.js 0.3.6 dist/Widgetly-Setup-0.3.6.exe
// 令牌只从进程环境读取，绝不写进仓库、配置文件或发布说明。
const fs = require('fs');
const path = require('path');
const https = require('https');

const [version, installerArg] = process.argv.slice(2);
const token = process.env.GITEE_TOKEN;
const owner = 'widgetly';
const repo = 'widgetly-download';
if (!version || !installerArg) throw new Error('用法：node scripts/publish-gitee-release.js <版本号> <安装包路径>');
if (!token) throw new Error('缺少 GITEE_TOKEN；请仅在当前终端临时设置该环境变量。');
const installer = path.resolve(installerArg);
if (!fs.existsSync(installer)) throw new Error(`找不到安装包：${installer}`);

function request(method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gitee.com',
      path: `/api/v5${pathname}`,
      method,
      headers: { 'User-Agent': 'Widgetly-Release-Publisher', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = data && (data.message || data.error_description || data.raw);
          reject(new Error(`Gitee API ${res.statusCode}: ${message || '请求失败'}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createRelease() {
  const body = JSON.stringify({
    access_token: token,
    tag_name: `v${version}`,
    target_commitish: 'master',
    name: `Widgetly v${version}`,
    body: `## Widgetly v${version}\n\n这是 Widgetly 的国内下载镜像。\n\n- 下载附件：\`Widgetly-Setup-${version}.exe\`\n- 官方源码与完整发布记录：[GitHub · Widgetly](https://github.com/3226194802/widgetly)`,
    prerelease: false,
  });
  return request('POST', `/repos/${owner}/${repo}/releases`, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, body);
}

function attachInstaller(releaseId) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(installer);
    const boundary = `----WidgetlyRelease${Date.now().toString(16)}`;
    const before = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${token}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/vnd.microsoft.portable-executable\r\n\r\n',
      'utf8'
    );
    const after = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const size = fs.statSync(installer).size;
    const req = https.request({
      hostname: 'gitee.com',
      path: `/api/v5/repos/${owner}/${repo}/releases/${releaseId}/attach_files`,
      method: 'POST',
      headers: {
        'User-Agent': 'Widgetly-Release-Publisher',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': before.length + size + after.length,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Gitee 附件上传 ${res.statusCode}: ${(data && (data.message || data.raw)) || '请求失败'}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(before);
    const source = fs.createReadStream(installer);
    source.on('error', reject);
    source.on('end', () => req.end(after));
    source.pipe(req, { end: false });
  });
}

(async () => {
  const release = await createRelease();
  const asset = await attachInstaller(release.id);
  const assets = Array.isArray(asset) ? asset : [asset];
  const uploaded = assets.find((item) => item && (item.name === path.basename(installer) || item.browser_download_url || item.download_url)) || assets[0] || {};
  console.log(JSON.stringify({
    tag: release.tag_name || `v${version}`,
    releaseUrl: release.html_url || `https://gitee.com/${owner}/${repo}/releases/tag/v${version}`,
    downloadUrl: uploaded.browser_download_url || uploaded.download_url || uploaded.url || '',
    filename: path.basename(installer),
    bytes: fs.statSync(installer).size,
  }));
})().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
