// Скачивает ONNX-модели шумодава DTLN (MIT, github.com/breizhn/DTLN) и сверяет SHA-256.
// Модели уже лежат в репозитории; скрипт нужен, если их удалили или хочется перекачать.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'renderer', 'models', 'dtln');
const BASE = 'https://github.com/breizhn/DTLN/raw/master';

const FILES = [
  { url: `${BASE}/pretrained_model/model_1.onnx`, name: 'model_1.onnx', sha256: '22b91cae3855e5a0620e66a917ca6c82c58db0e842c770f58d86751c5e8d4ae3' },
  { url: `${BASE}/pretrained_model/model_2.onnx`, name: 'model_2.onnx', sha256: 'e20c92f9233fccf29cddf86970d0d0161a03aebccc26d6f4d5639c4d5ec2e639' },
  { url: `${BASE}/LICENSE`, name: 'LICENSE' },
];

fs.mkdirSync(target, { recursive: true });
for (const file of FILES) {
  process.stdout.write(`${file.name} … `);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (file.sha256) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== file.sha256) throw new Error(`${file.name}: SHA-256 не совпадает (${actual})`);
  }
  fs.writeFileSync(path.join(target, file.name), data);
  console.log(`${(data.length / 1024).toFixed(0)} КБ, ок`);
}
console.log(`Модели сохранены в ${path.relative(root, target)}`);
