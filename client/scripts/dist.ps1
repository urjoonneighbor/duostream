# Сборка установщика и portable-версии DuoStream: npm run dist
#  1. собирает собственный захват (нужен .NET SDK 10);
#  2. скачивает инструменты electron-builder (7-Zip, NSIS) через PowerShell с проверкой SHA-256 —
#     загрузка из Node с GitHub на некоторых сетях обрывается (RequestError) — и кладёт их в build-tools/;
#  3. запускает electron-builder. Результат — в dist/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'build-tools'
$base = 'https://github.com/electron-userland/electron-builder-binaries/releases/download'
# Те же версии и контрольные суммы, что зашиты в electron-builder (app-builder-lib/out/toolsets)
$assets = @{
  sevenZip      = @{ Dir = '7zip'; Url = "$base/7zip@1.0.0/7zip-win-x64.tar.gz"; Sha = 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3' }
  nsis          = @{ Dir = 'nsis'; Url = "$base/nsis-3.0.4.1/nsis-3.0.4.1.7z"; Sha = '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa' }
  nsisResources = @{ Dir = 'nsis-resources'; Url = "$base/nsis-resources-3.4.1/nsis-resources-3.4.1.7z"; Sha = '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103' }
}

function Get-Tool($asset, $sevenZip) {
  $dir = Join-Path $tools $asset.Dir
  if (Test-Path (Join-Path $dir '.ok')) { return $dir }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $tools (Split-Path $asset.Url -Leaf)
  Write-Host "[dist] скачиваю $(Split-Path $asset.Url -Leaf)"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing $asset.Url -OutFile $file
  if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $asset.Sha) { throw "SHA-256 не совпадает: $file" }
  if ($file.EndsWith('.tar.gz')) { tar -xzf $file -C $dir } else { & $sevenZip x $file "-o$dir" -y | Out-Null }
  if ($LASTEXITCODE) { throw "не удалось распаковать $file" }
  Remove-Item $file
  New-Item (Join-Path $dir '.ok') -ItemType File | Out-Null
  return $dir
}

Set-Location $root
node scripts/build-native.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$sevenZip = (Get-ChildItem (Get-Tool $assets.sevenZip) -Recurse -Filter '7za.exe' | Select-Object -First 1).FullName
$env:ELECTRON_BUILDER_7ZIP_PATH = $sevenZip
$env:ELECTRON_BUILDER_NSIS_DIR = Get-Tool $assets.nsis $sevenZip
$env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = Get-Tool $assets.nsisResources $sevenZip

npx electron-builder --win nsis portable
exit $LASTEXITCODE
