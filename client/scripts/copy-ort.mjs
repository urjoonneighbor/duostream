// Копирует WASM-сборку ONNX Runtime Web в renderer/vendor/ort, чтобы рендерер
// загружал её по протоколу app:// без сборщика и без доступа к node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let distDir;
try {
  // exports пакета не отдают package.json, поэтому берём каталог основного файла (он лежит в dist/)
  distDir = path.dirname(require.resolve('onnxruntime-web'));
} catch {
  console.error('[copy-ort] onnxruntime-web не установлен — выполните npm install в папке client');
  process.exit(1);
}

const files = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const target = path.join(root, 'src', 'renderer', 'vendor', 'ort');
fs.mkdirSync(target, { recursive: true });

for (const name of files) {
  const from = path.join(distDir, name);
  if (!fs.existsSync(from)) {
    console.error(`[copy-ort] В ${distDir} нет ${name}. Версия onnxruntime-web несовместима с проектом.`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(target, name));
}
console.log(`[copy-ort] ONNX Runtime Web скопирован в ${path.relative(root, target)}`);
