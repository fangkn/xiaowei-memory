export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
export const EXPORT_MEDIA_ORIGINS = ['https://*.sinaimg.cn/*', 'https://img.t.sinajs.cn/*', 'https://face.t.sinajs.cn/*'];

function supportedMediaHost(host) {
  return host === 'sinaimg.cn' || host.endsWith('.sinaimg.cn') || host === 'img.t.sinajs.cn' || host === 'face.t.sinajs.cn';
}

// 旧记录只在读取时升级协议；保留原域名、路径和查询参数，不改数据库快照。
export function normalizeExportMediaURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  const input = value.trim();
  if (!/^(?:https?:\/\/|\/\/)/i.test(input) || /[\u0000-\u001f\u007f\\]/.test(input)) return '';
  try {
    const url = new URL(input.startsWith('//') ? `https:${input}` : input);
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password || !supportedMediaHost(url.hostname)) return '';
    url.protocol = 'https:';
    url.hash = '';
    return url.href.length <= 4096 ? url.href : '';
  } catch { return ''; }
}

export function validExportMediaURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      supportedMediaHost(url.hostname);
  } catch { return false; }
}

// CDN responses sometimes use application/octet-stream. Inspect the bytes, never
// accept an HTML error page just because its URL or Content-Type says "image".
export function imageMime(bytes) {
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) return '';
  const starts = values => values.every((value, index) => bytes[index] === value);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      for (let offset = 8; offset + 4 <= Math.min(boxSize, 128); offset += 4) {
        if (offset !== 12 && ['avif', 'avis'].includes(ascii(offset, offset + 4))) return 'image/avif';
      }
    }
  }
  return '';
}

export function usableExportMedia(media) {
  return Boolean(media?.bytes?.byteLength && media.bytes.byteLength <= MAX_MEDIA_BYTES &&
    imageMime(media.bytes) && imageMime(media.bytes) === media.mime);
}

function mediaError(message) { return Object.assign(new Error(message), {code: 'EXPORT_MEDIA'}); }

/** Read only bounded, public Sinaimg image bytes; no page cookies or credentials. */
export async function fetchExportMedia(url, {fetchImpl = globalThis.fetch, timeoutMs = 20000} = {}) {
  if (!validExportMediaURL(url)) throw mediaError('图片地址无效，仅支持 HTTPS 微博图片地址。');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentURL = url, response;
    for (let hop = 0; hop <= 3; hop++) {
      response = await fetchImpl(currentURL, {credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'manual', cache: 'no-store', signal: controller.signal});
      if (response.type === 'opaqueredirect') throw mediaError('图片服务器返回了无法安全核对的跳转，请重新采集该微博后重试。');
      if (response.url && !validExportMediaURL(response.url)) throw mediaError('图片跳转到了不支持的地址，已停止读取。');
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      let next;
      try { next = new URL(location || '', currentURL).href; } catch { /* Invalid redirect is rejected below. */ }
      await response.body?.cancel();
      if (!location || !validExportMediaURL(next)) throw mediaError('图片跳转到了不支持的地址，已停止读取。');
      if (hop === 3) throw mediaError('图片跳转次数过多，请重新采集该微博后重试。');
      currentURL = next;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw mediaError(response.status === 403 ? '图片服务器仍拒绝读取（HTTP 403），请确认扩展已更新并重新加载；若原微博也无法显示该图，图片可能已失效。'
        : `图片读取失败（HTTP ${response.status}），请稍后重试。`);
    }
    if (Number(response.headers.get('content-length') || 0) > MAX_MEDIA_BYTES) {
      await response.body?.cancel();
      throw mediaError('单张图片超过 12 MiB，已跳过该图片。');
    }
    if (!response.body?.getReader) throw mediaError('图片响应缺少可读取的数据。');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) { await reader.cancel(); throw mediaError('单张图片超过 12 MiB，已跳过该图片。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const mime = imageMime(bytes);
    if (!mime) throw mediaError('服务器没有返回有效图片，可能是图片失效或访问限制；请重新采集后重试。');
    return {url, bytes, mime};
  } catch (error) {
    if (error?.code === 'EXPORT_MEDIA') throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw mediaError('图片读取超时，请稍后重试。');
    throw mediaError('图片网络读取失败，请检查网络并稍后重试。');
  } finally { clearTimeout(timer); }
}
