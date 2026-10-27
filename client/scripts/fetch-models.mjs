// Скачивает ONNX-модели шумодава и сверяет SHA-256:
//  • DeepFilterNet3 (MIT/Apache-2.0, github.com/Rikorose/DeepFilterNet) — потоковый экспорт torchDF
//    (github.com/grazder/DeepFilterNet), зеркало huggingface.co/kimtos-labs/denoiser-dfn3;
//  • Silero VAD (MIT, github.com/snakers4/silero-vad) — распознаватель речи для голосового порога;
//  • DTLN (MIT, github.com/breizhn/DTLN).
// Модели уже лежат в репозитории; скрипт нужен, если их удалили или хочется перекачать.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'renderer', 'models');
const DTLN = 'https://github.com/breizhn/DTLN/raw/master';

const FILES = [
  {
    dir: 'dfn3',
    name: 'denoiser_model.onnx',
    url: 'https://huggingface.co/kimtos-labs/denoiser-dfn3/resolve/main/denoiser_model.onnx',
    sha256: 'fe5eb64fa2e4154c83f8e4935e82871c850c154387ee892e0ab65fe179e7d8c9',
  },
  { dir: 'dfn3', name: 'LICENSE-MIT', url: 'https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/LICENSE-MIT' },
  {
    dir: 'silero',
    name: 'silero_vad.onnx',
    url: 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
  },
  { dir: 'silero', name: 'LICENSE', url: 'https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE' },
  {
    dir: 'dtln',
    name: 'model_1.onnx',
    url: `${DTLN}/pretrained_model/model_1.onnx`,
    sha256: '22b91cae3855e5a0620e66a917ca6c82c58db0e842c770f58d86751c5e8d4ae3',
  },
  {
    dir: 'dtln',
    name: 'model_2.onnx',
    url: `${DTLN}/pretrained_model/model_2.onnx`,
    sha256: 'e20c92f9233fccf29cddf86970d0d0161a03aebccc26d6f4d5639c4d5ec2e639',
  },
  { dir: 'dtln', name: 'LICENSE', url: `${DTLN}/LICENSE` },
];

for (const file of FILES) {
  const dir = path.join(target, file.dir);
  fs.mkdirSync(dir, { recursive: true });
  process.stdout.write(`${file.dir}/${file.name} … `);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (file.sha256) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== file.sha256) throw new Error(`${file.name}: SHA-256 не совпадает (${actual})`);
  }
  fs.writeFileSync(path.join(dir, file.name), data);
  console.log(`${(data.length / 1024).toFixed(0)} КБ, ок`);
}
console.log(`Модели сохранены в ${path.relative(root, target)}`);
