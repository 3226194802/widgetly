// 从官方 GitHub Release 下载一个指定资产，跟随 GitHub 的重定向并验证预期字节数。
const fs = require('fs');
const path = require('path');
const https = require('https');

const [url, output, expectedSizeText] = process.argv.slice(2);
if (!url || !output) throw new Error('用法：node scripts/download-release-asset.js <URL> <输出路径> [预期字节数]');
const expectedSize = expectedSizeText ? Number(expectedSizeText) : 0;
const destination = path.resolve(output);

function download(urlToGet, redirects = 0) {
  if (redirects > 8) throw new Error('GitHub 下载重定向次数过多。');
  https.get(urlToGet, { headers: { 'User-Agent': 'Widgetly-Release-Mirror', Accept: 'application/octet-stream' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      download(new URL(res.headers.location, urlToGet).toString(), redirects + 1);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`GitHub 下载失败：HTTP ${res.statusCode}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const outputStream = fs.createWriteStream(destination);
    res.pipe(outputStream);
    outputStream.on('finish', () => {
      outputStream.close(() => {
        const size = fs.statSync(destination).size;
        if (expectedSize && size !== expectedSize) {
          console.error(`下载大小异常：实际 ${size} 字节，预期 ${expectedSize} 字节。`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ output: destination, bytes: size }));
      });
    });
    outputStream.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  }).on('error', (error) => { console.error(error.message); process.exitCode = 1; });
}

download(url);
