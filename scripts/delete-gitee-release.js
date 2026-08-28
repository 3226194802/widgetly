// 删除指定的 Gitee Release。令牌仅从当前进程环境读取，不写入磁盘。
const https = require('https');
const releaseId = process.argv[2];
const token = process.env.GITEE_TOKEN;
if (!releaseId || !token) throw new Error('需要 Release ID 与 GITEE_TOKEN。');
const requestPath = `/api/v5/repos/widgetly/widgetly-download/releases/${encodeURIComponent(releaseId)}?access_token=${encodeURIComponent(token)}`;
const req = https.request({
  hostname: 'gitee.com', path: requestPath, method: 'DELETE',
  headers: { 'User-Agent': 'Widgetly-Release-Publisher' },
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error(`Gitee 删除发行版失败：${res.statusCode} ${data}`);
      process.exitCode = 1;
    } else console.log(`已删除 Gitee Release ${releaseId}`);
  });
});
req.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
req.end();
