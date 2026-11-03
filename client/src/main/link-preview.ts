/**
 * Предпросмотр ссылок в чате: название, описание и картинка страницы.
 *
 * Страницу скачивает только отправитель сообщения (его приложение), а получателю по P2P приходит готовая
 * карточка — у получателя из чата ничего само не открывается и не загружается. YouTube отдаёт данные
 * своим oEmbed (название, канал, превью), остальные сайты — метатегами Open Graph / Twitter и <title>.
 *
 * Скачиваются только адреса из интернета: локальная сеть, сам компьютер и Tailscale (100.64.0.0/10)
 * отсекаются и для исходного адреса, и для каждого перенаправления.
 */
import { nativeImage, net } from 'electron';
import dns from 'node:dns/promises';
import net4 from 'node:net';
import type { LinkPreview } from '../shared/duo-api';

const TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 512 * 1024; // метатеги — в начале страницы
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const THUMB_WIDTH = 480;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DuoStream link preview';

const cache = new Map<string, LinkPreview | null>();

/** Адрес не из интернета: сам компьютер, локальная сеть, link-local, CGNAT/Tailscale, multicast */
function isPrivateAddress(ip: string): boolean {
  if (net4.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/** Можно ли скачивать этот адрес: http(s), стандартный порт не обязателен, хост — в интернете */
async function checkPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('не http(s)');
  if (url.username || url.password) throw new Error('адрес с логином');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net4.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('адрес не из интернета');
  return url;
}

/** GET с ручными перенаправлениями (каждое проверяется) и ограничением размера ответа */
async function fetchLimited(raw: string, accept: string, maxBytes: number): Promise<{ url: URL; type: string; body: Buffer }> {
  let url = await checkPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const response = await net.fetch(url.href, {
      redirect: 'manual',
      headers: { accept, 'user-agent': USER_AGENT, 'accept-language': 'ru,en;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error('слишком много перенаправлений');
      url = await checkPublicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk as Uint8Array);
      chunks.push(part);
      size += part.length;
      if (size >= maxBytes) break; // дальше не нужно (страница) или слишком велико (картинка — проверим ниже)
    }
    return { url, type: response.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const clean = (text: string | undefined, max: number) =>
  text ? decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined;

/** Текст страницы в её кодировке (заголовок Content-Type или <meta charset>) */
function decodeHtml(body: Buffer, contentType: string): string {
  const head = body.subarray(0, 4096).toString('latin1');
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Метатеги страницы: property/name → content (атрибуты в любом порядке) */
function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase();
    if (k && !tags.has(k)) tags.set(k, content[2] ?? content[3] ?? content[4] ?? '');
  }
  return tags;
}

/** Картинка → JPEG шириной до THUMB_WIDTH в data: URL (по каналу чата уходит одним сообщением) */
async function thumbnail(imageUrl: string): Promise<string | undefined> {
  try {
    const { type, body } = await fetchLimited(imageUrl, 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5', MAX_IMAGE_BYTES);
    if (!type.startsWith('image/') || type.includes('svg') || body.length >= MAX_IMAGE_BYTES) return undefined;
    let image = nativeImage.createFromBuffer(body);
    if (image.isEmpty()) return undefined; // формат, который nativeImage не читает (webp, avif)
    if (image.getSize().width > THUMB_WIDTH) image = image.resize({ width: THUMB_WIDTH, quality: 'good' });
    for (const quality of [78, 60, 45]) {
      const jpeg = image.toJPEG(quality);
      if (jpeg.length <= 100 * 1024) return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    }
  } catch {
    // без картинки — карточка всё равно полезна
  }
  return undefined;
}

const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i;

async function youtubePreview(url: URL): Promise<LinkPreview | null> {
  const { body } = await fetchLimited(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`,
    'application/json',
    256 * 1024,
  );
  const data = JSON.parse(body.toString('utf8')) as { title?: string; author_name?: string; thumbnail_url?: string };
  const title = clean(data.title, 300);
  if (!title) return null;
  return {
    url: url.href,
    site: 'YouTube',
    title,
    description: clean(data.author_name, 200),
    // hqdefault — 4:3 с чёрными полосами; mqdefault — тот же кадр 16:9 без полос
    image: data.thumbnail_url ? await thumbnail(data.thumbnail_url.replace(/\/hqdefault\.jpg$/, '/mqdefault.jpg')) : undefined,
    video: true,
  };
}

async function pagePreview(raw: string): Promise<LinkPreview | null> {
  const { url, type, body } = await fetchLimited(raw, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', MAX_HTML_BYTES);
  if (!/html/i.test(type)) return null;
  const html = decodeHtml(body, type);
  const meta = metaTags(html);
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? /<title[^>]*>([^<]*)/i.exec(html)?.[1], 300);
  if (!title) return null;
  const imageRaw = meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image');
  let image: string | undefined;
  if (imageRaw) {
    try {
      image = await thumbnail(new URL(decodeEntities(imageRaw), url).href);
    } catch {
      image = undefined;
    }
  }
  return {
    url: url.href,
    site: clean(meta.get('og:site_name'), 100) ?? url.hostname.replace(/^www\./, ''),
    title,
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 400),
    image,
    video: /^video/i.test(meta.get('og:type') ?? ''),
  };
}

/** Карточка ссылки или null (не страница, нет названия, адрес не из интернета, ошибка сети) */
export async function linkPreview(raw: string): Promise<LinkPreview | null> {
  if (cache.has(raw)) return cache.get(raw) ?? null;
  let result: LinkPreview | null = null;
  try {
    const url = await checkPublicUrl(raw);
    result = YOUTUBE_HOSTS.test(url.hostname) ? await youtubePreview(url) : await pagePreview(raw);
  } catch {
    result = null;
  }
  cache.set(raw, result);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return result;
}
