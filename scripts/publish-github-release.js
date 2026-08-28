// 发布 Widgetly 到 GitHub Releases。令牌仅从 GITHUB_TOKEN 环境变量读取。
const fs = require('fs');
const path = require('path');
const https = require('https');

const [version, ...assetArgs] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const owner = '3226194802';
const repo = 'widgetly-releases';
if (!version || assetArgs.length === 0) throw new Error('用法：node scripts/publish-github-release.js <版本号> <资产文件...>');
if (!token) throw new Error('缺少 GITHUB_TOKEN；请只在当前终端临时设置。');
const assets = assetArgs.map((asset) => path.resolve(asset));
assets.forEach((asset) => { if (!fs.existsSync(asset)) throw new Error(`找不到发布资产：${asset}`); });

function apiRequest(method, host, requestPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: requestPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Widgetly-Release-Publisher',
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode}: ${(data && (data.message || data.raw)) || '请求失败'}`));
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
    tag_name: `v${version}`,
    target_commitish: 'main',
    name: `Widgetly v${version}`,
    body: `## Widgetly v${version}\n\n### 下载\n\n- \`Widgetly-Setup-${version}.exe\`：Windows 安装版（推荐）\n\n### 更新内容\n\n- 新增组件坞与桌面组件管理能力。\n- 修复组件菜单、透明度、鼠标穿透及组件尺寸适配相关问题。\n- 国内镜像下载：请前往 [Gitee 国内下载页](https://gitee.com/widgetly/widgetly-download/releases/tag/v${version})。`,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
  });
  return apiRequest('POST', 'api.github.com', `/repos/${owner}/${repo}/releases`, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, body);
}

function uploadAsset(uploadUrl, asset) {
  return new Promise((resolve, reject) => {
    const base = uploadUrl.replace(/\{.*$/, '');
    const url = new URL(base);
    url.searchParams.set('name', path.basename(asset));
    const size = fs.statSync(asset).size;
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Widgetly-Release-Publisher',
        'Content-Type': asset.endsWith('.yml') ? 'application/x-yaml' : 'application/octet-stream',
        'Content-Length': size,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub 资产上传 ${res.statusCode}: ${(data && (data.message || data.raw)) || '请求失败'}`));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    const source = fs.createReadStream(asset);
    source.on('error', reject);
    source.pipe(req);
  });
}

(async () => {
  const release = await createRelease();
  const uploaded = [];
  for (const asset of assets) {
    const result = await uploadAsset(release.upload_url, asset);
    uploaded.push({ name: result.name, bytes: result.size, url: result.browser_download_url });
  }
  console.log(JSON.stringify({ tag: release.tag_name, releaseUrl: release.html_url, assets: uploaded }));
})().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
