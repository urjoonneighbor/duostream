// Иконки приложения из src/renderer/img/icon.svg: PNG нужных размеров (SVG рисует canvas Chromium — гладкие
// края и прозрачный фон) и build/icon.ico для exe, установщика и ярлыков.
//
//   npx electron scripts/make-icons.mts
//
// Нужен только при смене иконки: результат лежит в репозитории.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'src', 'renderer', 'img', 'icon.svg'), 'utf8');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Все размеры за один заход: SVG → <img> → <canvas> нужного размера → PNG */
async function renderAll(sizes: number[]): Promise<Buffer[]> {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
  const dataUrls: string[] = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    await img.decode();
    return ${JSON.stringify(sizes)}.map((size) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      return canvas.toDataURL('image/png');
    });
  })()`);
  win.destroy();
  return dataUrls.map((url) => Buffer.from(url.split(',')[1] ?? '', 'base64'));
}

/** ICO из PNG: заголовок, каталог, данные (PNG внутри ICO поддерживается с Windows Vista) */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.png)]);
}

void app.whenReady().then(async () => {
  const pngs = await renderAll(SIZES);
  const images = SIZES.map((size, i) => ({ size, png: pngs[i]! }));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(images));
  // Иконка окна (её видно и при запуске из исходников, где exe — electron.exe)
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'img', 'icon-256.png'), images.at(-1)!.png);
  console.log(`build/icon.ico: ${SIZES.join(', ')} px; src/renderer/img/icon-256.png`);
  app.quit();
});
