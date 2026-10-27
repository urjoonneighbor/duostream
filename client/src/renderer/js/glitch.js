// Зритель: детектор кадров-выбросов — коротких визуальных глюков (сдвиг, разрыв, «копии» картинки, пятна).
//
// Выброс — одиночный кадр, который сильно отличается и от предыдущего, и от следующего, хотя они между собой
// похожи. Обычная смена сцены так не выглядит: новый кадр похож на следующий. Сравнение — по уменьшенной
// до 64×36 яркости каждого показанного кадра. Найденный кадр и соседние сохраняются картинкой рядом
// с журналом сеанса: глюк длиной в кадр скриншотер не ловит, а так он будет в файле.
//
// Детектор видит кадры после декодирования. Если глюк виден на экране, а детектор молчит — ломается вывод
// на экран (видеокарта), а не передача и не декодер.

const W = 64;
const H = 36;
const THRESHOLD = 10; // средняя разница яркости 0..255, выше — «другой кадр»
const SIMILAR = 0.4; // соседи выброса похожи между собой: их разница меньше 40% от разницы с выбросом
const MAX_SAVED = 20; // картинок за сеанс
const FLASH_BRIGHTER = 12; // вспышка: средняя яркость выше обоих соседей хотя бы на столько (0..255)
const FLAT_STD = 12; // кадр почти однотонный (засвечен целиком)
const DARKER_BY = 8; // пиксель «потемнел»: темнее обоих соседних кадров больше чем на столько
const DARKER_SHARE = 0.03; // у вспышки таких пикселей меньше 3%

export class GlitchDetector {
  /**
   * @param {HTMLVideoElement} video
   * @param {(info:object) => void} onGlitch
   */
  constructor(video, onGlitch) {
    this.video = video;
    this.onGlitch = onGlitch;
    this.canvas = new OffscreenCanvas(W, H);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.frames = []; // последние 3: {luma, bitmap, time, w, h}
    this.count = 0;
    this.checked = 0;
    this.saved = 0;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async (_now, meta) => {
      if (!this.running) return;
      try {
        await this.onFrame(meta);
      } catch {
        // кадр уже недоступен (поток сменился) — пропускаем
      }
      if (this.running) this.handle = this.video.requestVideoFrameCallback(tick);
    };
    this.handle = this.video.requestVideoFrameCallback(tick);
  }

  stop() {
    this.running = false;
    if (this.handle) this.video.cancelVideoFrameCallback(this.handle);
    for (const f of this.frames) f.bitmap?.close();
    this.frames = [];
  }

  async onFrame(meta) {
    const v = this.video;
    if (!v.videoWidth) return;
    this.ctx.drawImage(v, 0, 0, W, H);
    const rgba = this.ctx.getImageData(0, 0, W, H).data;
    const luma = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < luma.length; i += 4, j++) luma[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    const bitmap = await createImageBitmap(v, { resizeWidth: 480, resizeHeight: Math.round((480 * v.videoHeight) / v.videoWidth) });
    this.frames.push({ luma, bitmap, time: meta?.mediaTime ?? 0, w: v.videoWidth, h: v.videoHeight });
    if (this.frames.length > 3) this.frames.shift().bitmap.close();
    if (this.frames.length === 3) this.check();
  }

  check() {
    const [a, b, c] = this.frames;
    this.checked++;
    if (a.w !== b.w || b.w !== c.w || a.h !== b.h || b.h !== c.h) return; // смена размера — не глюк
    const ab = diff(a.luma, b.luma);
    const bc = diff(b.luma, c.luma);
    const ac = diff(a.luma, c.luma);
    if (ab < THRESHOLD || bc < THRESHOLD || ac > SIMILAR * Math.min(ab, bc)) return;
    if (isFlash(a.luma, b.luma, c.luma)) return; // вспышка в кадре (взрыв, молния, выстрел), не глюк
    this.count++;
    const info = { at: new Date().toISOString(), size: `${b.w}×${b.h}`, diffPrev: ab.toFixed(1), diffNext: bc.toFixed(1), diffNeighbours: ac.toFixed(1) };
    if (this.saved < MAX_SAVED) {
      this.saved++;
      info.image = strip([a.bitmap, b.bitmap, c.bitmap]);
    }
    this.onGlitch(info);
  }
}

/**
 * Вспышка (взрыв, молния, выстрел): кадр ярче обоих соседей, и свет только добавлен — почти ни один
 * пиксель не стал темнее соседних кадров. Или кадр залит светом целиком. Глюк — сдвиг, копии, пятна,
 * «кадр без яркости» — всегда где-то темнит картинку, такие отметки остаются.
 */
function isFlash(a, b, c) {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const mb = mean(b);
  if (mb < Math.max(mean(a), mean(c)) + FLASH_BRIGHTER) return false;
  let darker = 0;
  let sq = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] < Math.min(a[i], c[i]) - DARKER_BY) darker++;
    sq += (b[i] - mb) ** 2;
  }
  if (Math.sqrt(sq / b.length) < FLAT_STD) return true; // засвечен целиком
  return darker / b.length < DARKER_SHARE;
}

function diff(x, y) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

/** Три кадра в ряд (предыдущий, выброс, следующий) — data:image/png */
function strip(bitmaps) {
  const w = bitmaps[0].width;
  const h = bitmaps[0].height;
  const canvas = document.createElement('canvas');
  canvas.width = w * 3 + 8;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f00';
  ctx.fillRect(0, 0, canvas.width, h);
  bitmaps.forEach((bmp, i) => ctx.drawImage(bmp, i * (w + 4), 0));
  return canvas.toDataURL('image/png');
}
