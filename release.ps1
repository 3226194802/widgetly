# 本地一键发布脚本(需要已安装 GitHub CLI: winget install GitHub.cli)
# 用法:  .\release.ps1 0.3.0
# 说明：版本号会同步写入 package.json 与 package-lock.json，再构建并上传安装包、便携版和在线更新清单。
param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

Write-Host "== 1/3 更新版本号到 $Version ==" -ForegroundColor Cyan
node -e "const fs=require('fs');const v=process.argv[1];for(const p of ['package.json','package-lock.json']){const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=v;if(j.packages&&j.packages[''])j.packages[''].version=v;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');}" $Version

Write-Host "== 2/3 构建(安装版 + 便携版) ==" -ForegroundColor Cyan
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build

Write-Host "== 3/3 上传 GitHub Release v$Version ==" -ForegroundColor Cyan
gh release create "v$Version" `
    "dist/Widgetly-Setup-$Version.exe" `
    "dist/Widgetly-Portable-$Version.exe" `
    "dist/latest.yml" `
    "dist/Widgetly-Setup-$Version.exe.blockmap" `
    --title "Widgetly v$Version" `
    --notes "新版本 v$Version"

Write-Host "完成! 用户的『检查更新』将自动发现 v$Version" -ForegroundColor Green
