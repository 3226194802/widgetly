// 为 NSIS 安装包生成 electron-updater 所需的 latest.yml。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [version, installerArg, outputArg] = process.argv.slice(2);
if (!version || !installerArg || !outputArg) throw new Error('用法：node scripts/generate-latest-yml.js <版本号> <安装包> <latest.yml 输出路径>');
const installer = path.resolve(installerArg);
const output = path.resolve(outputArg);
if (!fs.existsSync(installer)) throw new Error(`找不到安装包：${installer}`);
const name = path.basename(installer);
const size = fs.statSync(installer).size;
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
const yaml = [
  `version: ${version}`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, yaml, 'utf8');
console.log(JSON.stringify({ version, installer: name, bytes: size, sha512, output }));
