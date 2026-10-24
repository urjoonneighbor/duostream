# Ставит Electron в node_modules\electron\dist, если его ещё нет.
# Новые версии пакета electron скачивают сам Electron не при npm install, а при первом запуске,
# а сборке (electronDist в package.json) он нужен заранее. Сначала пробуем штатный установщик
# пакета (через Node), а если Node не достучался до GitHub — PowerShell с проверкой SHA-256
# по checksums.json из пакета electron.
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$pkg = Join-Path $Root 'node_modules\electron'
$exe = Join-Path $pkg 'dist\electron.exe'
if (Test-Path $exe) { exit 0 }
if (-not (Test-Path (Join-Path $pkg 'package.json'))) { throw 'нет node_modules\electron — сначала выполните npm install' }

Write-Host '[electron] Electron ещё не скачан, скачиваю…'
& node (Join-Path $pkg 'install.js')
if (Test-Path $exe) { exit 0 }

$version = (Get-Content (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version
$name = "electron-v$version-win32-x64.zip"
$expected = (Get-Content (Join-Path $pkg 'checksums.json') -Raw | ConvertFrom-Json).$name
Write-Host "[electron] через Node не вышло — скачиваю $name через PowerShell"
$zip = Join-Path ([IO.Path]::GetTempPath()) $name
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -UseBasicParsing "https://github.com/electron/electron/releases/download/v$version/$name" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) {
  Remove-Item $zip
  throw "SHA-256 не совпадает: $name"
}
$dist = Join-Path $pkg 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
tar -xf $zip -C $dist
if ($LASTEXITCODE) { throw "не удалось распаковать $name" }
Remove-Item $zip
Set-Content -NoNewline -Encoding ascii (Join-Path $pkg 'path.txt') 'electron.exe'
if (-not (Test-Path $exe)) { throw 'electron.exe не появился после распаковки' }
Write-Host "[electron] готово: Electron $version"
