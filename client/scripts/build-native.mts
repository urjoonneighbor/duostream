// Сборка собственного захвата (native/capture → native/bin/duostream-capture.exe).
// Нужен .NET SDK 10: если его нет на ПК, скрипт сам скачивает официальный zip с builds.dotnet.microsoft.com
// (SHA-512 сверяется с метаданными релиза) в build-tools/dotnet — без установки и прав администратора.
// Результат — самодостаточный exe: на ПК пользователя .NET не требуется.
//
//   node scripts/build-native.mts            — собрать (ошибка, если собрать не удалось)
//   node scripts/build-native.mts --optional — для postinstall: при неудаче только предупредить
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optional = process.argv.includes('--optional');
const project = path.join(root, 'native', 'capture', 'DuoCapture.csproj');
const output = path.join(root, 'native', 'bin');
const localDotnetDir = path.join(root, 'build-tools', 'dotnet');
const localDotnet = path.join(localDotnetDir, 'dotnet.exe');
const RELEASES_URL = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json';
const SDK_FILE = 'dotnet-sdk-win-x64.zip';

/** Без телеметрии и приветствия при первом запуске */
const quietEnv: NodeJS.ProcessEnv = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

function skip(reason: string): never {
  const text = `[build-native] ${reason}. Будет использоваться захват Chromium (до ~60 FPS на Windows 11 24H2+).`;
  if (optional) {
    console.warn(text);
    process.exit(0);
  }
  console.error(text);
  process.exit(1);
}

const hasSdk10 = (dotnet: string, env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(dotnet, ['--list-sdks'], { encoding: 'utf8', env: { ...process.env, ...quietEnv, ...env } });
  return result.status === 0 && /^10\./m.test(result.stdout);
};

/** Окружение для SDK из build-tools/dotnet: он не установлен в систему, поэтому путь к нему задаётся явно */
const localEnv = (): NodeJS.ProcessEnv => ({
  DOTNET_ROOT: localDotnetDir,
  DOTNET_MULTILEVEL_LOOKUP: '0',
  PATH: `${localDotnetDir}${path.delimiter}${process.env.PATH ?? ''}`,
});

interface SdkFile {
  name: string;
  rid?: string;
  url: string;
  hash: string;
}
interface ReleasesJson {
  'latest-sdk': string;
  releases: { sdks?: { version: string; files: SdkFile[] }[] }[];
}

/** SHA-512 потока (hex); если задан out — поток заодно пишется в него */
async function sha512(input: AsyncIterable<Uint8Array>, out?: fs.WriteStream): Promise<string> {
  const hash = crypto.createHash('sha512');
  for await (const chunk of input) {
    hash.update(chunk);
    if (out && !out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
  }
  if (out) await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return hash.digest('hex');
}

/** Скачивает последний .NET SDK 10 (zip для win-x64) в build-tools/dotnet */
async function downloadSdk(): Promise<void> {
  const meta = (await (await fetch(RELEASES_URL)).json()) as ReleasesJson;
  const version = meta['latest-sdk'];
  const sdk = meta.releases.flatMap((r) => r.sdks ?? []).find((s) => s.version === version);
  const file = sdk?.files.find((f) => f.name === SDK_FILE);
  if (!file) throw new Error(`в ${RELEASES_URL} нет ${SDK_FILE} для SDK ${version}`);

  const tools = path.dirname(localDotnetDir);
  fs.mkdirSync(tools, { recursive: true });
  const zip = path.join(tools, `dotnet-sdk-${version}-win-x64.zip`);
  const expected = file.hash.toLowerCase();
  // zip, скачанный в прошлый раз (если распаковка тогда не удалась), заново не качаем
  if (!fs.existsSync(zip) || (await sha512(fs.createReadStream(zip))) !== expected) {
    console.log(`[build-native] .NET SDK 10 не найден — скачиваю ${version} (~300 МБ) в ${path.relative(root, localDotnetDir)}`);
    const response = await fetch(file.url);
    if (!response.ok || !response.body) throw new Error(`${file.url}: HTTP ${response.status}`);
    const partial = `${zip}.part`;
    const out = fs.createWriteStream(partial);
    const actual = await sha512(Readable.fromWeb(response.body), out);
    if (actual !== expected) {
      fs.rmSync(partial, { force: true });
      throw new Error('SHA-512 скачанного SDK не совпадает с опубликованным');
    }
    fs.renameSync(partial, zip);
  }

  // Распаковка во временную папку и переименование: прерванная распаковка не оставит полусобранный SDK.
  // tar.exe — системный (bsdtar Windows умеет zip); tar из Git Bash принял бы «D:» за адрес сервера
  const temp = `${localDotnetDir}.tmp`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const tar = spawnSync(systemTar, ['-xf', zip, '-C', temp], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`не удалось распаковать ${zip}`);
  fs.rmSync(zip, { force: true });
  fs.rmSync(localDotnetDir, { recursive: true, force: true });
  fs.renameSync(temp, localDotnetDir);
}

/** dotnet и окружение для него: системный SDK, ранее скачанный или скачанный сейчас */
async function findDotnet(): Promise<{ dotnet: string; env: NodeJS.ProcessEnv }> {
  if (hasSdk10('dotnet')) return { dotnet: 'dotnet', env: quietEnv };
  if (!fs.existsSync(localDotnet) || !hasSdk10(localDotnet, localEnv())) {
    try {
      await downloadSdk();
    } catch (err) {
      skip(`не найден .NET SDK 10, скачать его не удалось: ${(err as Error).message}`);
    }
    if (!hasSdk10(localDotnet, localEnv())) skip('скачанный .NET SDK 10 не запускается');
  }
  return { dotnet: localDotnet, env: { ...quietEnv, ...localEnv() } };
}

/**
 * Папка кэша пакетов NuGet (globalPackagesFolder в настройках ПК) может указывать на несуществующий
 * диск — тогда восстановление падает. В таком случае кладём пакеты в native/.nuget-packages.
 */
function packagesEnv(dotnet: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.env.NUGET_PACKAGES) return {};
  const locals = spawnSync(dotnet, ['nuget', 'locals', 'global-packages', '--list'], {
    encoding: 'utf8',
    cwd: path.dirname(project), // чтобы учитывался и nuget.config проекта
    env: { ...process.env, ...env },
  });
  const folder = /global-packages:\s*(.+)/i.exec(locals.stdout ?? '')?.[1]?.trim();
  if (!folder) return {};
  try {
    fs.mkdirSync(folder, { recursive: true });
    return {};
  } catch {
    const local = path.join(root, 'native', '.nuget-packages');
    console.warn(`[build-native] папка пакетов NuGet ${folder} недоступна — использую ${path.relative(root, local)}`);
    return { NUGET_PACKAGES: local };
  }
}

if (process.platform !== 'win32') skip('собственный захват есть только для Windows');
const { dotnet, env } = await findDotnet();

console.log('[build-native] dotnet publish …');
const result = spawnSync(
  dotnet,
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
  { stdio: 'inherit', env: { ...process.env, ...env, ...packagesEnv(dotnet, env) } },
);
if (result.status !== 0) skip('сборка собственного захвата не удалась (см. вывод выше)');

const exe = path.join(output, 'duostream-capture.exe');
if (!fs.existsSync(exe)) skip(`после сборки нет ${exe}`);
console.log(`[build-native] готово: ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} МБ)`);
