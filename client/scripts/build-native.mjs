// Сборка собственного захвата (native/capture → native/bin/duostream-capture.exe).
// Нужен .NET SDK 10. Результат — самодостаточный exe: на ПК пользователя .NET не требуется.
//
//   node scripts/build-native.mjs            — собрать (ошибка, если нет .NET SDK)
//   node scripts/build-native.mjs --optional — для postinstall: без .NET SDK просто предупредить
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optional = process.argv.includes('--optional');
const project = path.join(root, 'native', 'capture', 'DuoCapture.csproj');
const output = path.join(root, 'native', 'bin');

function skip(reason) {
  const text = `[build-native] ${reason}. Будет использоваться захват Chromium (до ~60 FPS на Windows 11 24H2+).`;
  if (optional) {
    console.warn(text);
    process.exit(0);
  }
  console.error(text);
  process.exit(1);
}

if (process.platform !== 'win32') skip('собственный захват есть только для Windows');
const dotnet = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8' });
if (dotnet.status !== 0 || !/^10\./m.test(dotnet.stdout)) {
  skip('не найден .NET SDK 10 (https://dotnet.microsoft.com/download), собственный захват не собран');
}

console.log('[build-native] dotnet publish …');
const result = spawnSync(
  'dotnet',
  [
    'publish', project,
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'true',
    '-p:PublishSingleFile=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:DebugType=none',
    '-o', output,
    '-nologo',
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) skip('сборка собственного захвата не удалась (см. вывод выше)');

const exe = path.join(output, 'duostream-capture.exe');
if (!fs.existsSync(exe)) skip(`после сборки нет ${exe}`);
console.log(`[build-native] готово: ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} МБ)`);
