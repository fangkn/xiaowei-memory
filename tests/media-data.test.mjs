import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchExportMedia, imageMime, MAX_MEDIA_BYTES, usableExportMedia, validExportMediaURL, normalizeExportMediaURL, EXPORT_MEDIA_ORIGINS} from '../extension/media-data.js';

const url = 'https://wx1.sinaimg.cn/large/photo.png';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nC8AAAAASUVORK5CYII=', 'base64'));
const fetcher = (body = png, options = {}) => async () => new Response(body, options);

test('legacy media normalize to HTTPS without changing host, path, or signed query', async () => {
  for (const [raw, expected] of [
    ['http://wx1.sinaimg.cn/large/photo.png?Expires=123&signature=a%2Fb#old', 'https://wx1.sinaimg.cn/large/photo.png?Expires=123&signature=a%2Fb'],
    ['//ww2.sinaimg.cn/bmiddle/old.jpg', 'https://ww2.sinaimg.cn/bmiddle/old.jpg'],
    ['http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/f0/dorachijing_org.gif', 'https://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/f0/dorachijing_org.gif'],
    ['//face.t.sinajs.cn/t4/appstyle/expression/ext/normal/e3/2018new_weixioa02_org.png', 'https://face.t.sinajs.cn/t4/appstyle/expression/ext/normal/e3/2018new_weixioa02_org.png'],
  ]) {
    assert.equal(normalizeExportMediaURL(raw), expected);
    assert.equal(validExportMediaURL(expected), true);
    let requested;
    await fetchExportMedia(expected, {fetchImpl: async value => {requested = value; return new Response(png);}});
    assert.equal(requested, expected);
  }
  assert.deepEqual(EXPORT_MEDIA_ORIGINS, ['https://*.sinaimg.cn/*', 'https://img.t.sinajs.cn/*', 'https://face.t.sinajs.cn/*']);
});

test('legacy normalization rejects untrusted domains, credentials, malformed URLs, and nonstandard ports', () => {
  for (const raw of [null, {}, '', '/relative.jpg', 'wx1.sinaimg.cn/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,abc',
    'https://evil.sinajs.cn/a.gif', 'https://x.img.t.sinajs.cn/a.gif', 'http://face.t.sinajs.cn.evil.test/a.gif',
    'http://user:password@wx1.sinaimg.cn/a.jpg', 'http://wx1.sinaimg.cn:8443/a.jpg', 'http://wx1.sinaimg.cn:443/a.jpg',
    'https://wx1.sinaimg.cn:80/a.jpg', 'https://wx1.sinaimg.cn/a\\b.jpg', 'https://wx1.sinaimg.cn/a\nb.jpg',
    'https://wx1.sinaimg.cn/' + 'a'.repeat(4096)]) assert.equal(normalizeExportMediaURL(raw), '', String(raw));
});

test('only credential-free HTTPS Sinaimg URLs are accepted', async () => {
  for (const bad of [null, {}, '', 'http://wx1.sinaimg.cn/x', 'https://sinaimg.cn.evil.test/x',
    'https://user:secret@wx1.sinaimg.cn/x', 'https://wx1.sinaimg.cn:8443/x', 'file:///tmp/image.png']) {
    assert.equal(validExportMediaURL(bad), false);
    await assert.rejects(fetchExportMedia(bad, {fetchImpl: () => { assert.fail('must not fetch'); }}), /地址无效/);
  }
  assert.equal(validExportMediaURL(url), true);
  assert.equal(validExportMediaURL('https://h5.sinaimg.cn/m/emoticon/icon/default/smile.png'), true);
});

test('real PNG bytes are returned despite generic MIME and every request omits cookies and referrer', async () => {
  let options;
  const image = await fetchExportMedia(url, {fetchImpl: async (requested, init) => {
    assert.equal(requested, url); options = init;
    return new Response(png, {headers:{'content-type':'application/octet-stream'}});
  }});
  assert.equal(image.url, url);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.bytes, png);
  assert.equal(usableExportMedia(image), true);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.cache, 'no-store', 'do not reuse cached hotlink-denial responses');
  assert.equal(options.headers, undefined);
});

test('recognized image signatures distinguish JPEG, GIF, WebP and AVIF from mislabeled HTML', () => {
  assert.equal(imageMime(Uint8Array.of(255,216,255,224)), 'image/jpeg');
  assert.equal(imageMime(new TextEncoder().encode('GIF89a')), 'image/gif');
  assert.equal(imageMime(Uint8Array.from(Buffer.from('524946460400000057454250', 'hex'))), 'image/webp');
  assert.equal(imageMime(Uint8Array.from(Buffer.from('00000010667479706176696600000000', 'hex'))), 'image/avif');
  assert.equal(imageMime(new TextEncoder().encode('<html>Forbidden</html>')), '');
  assert.equal(usableExportMedia({mime:'image/png', bytes:new TextEncoder().encode('<html>Forbidden</html>')}), false);
  assert.equal(usableExportMedia({mime:'image/jpeg',bytes:png}), false);
  assert.equal(usableExportMedia({mime:'image/png',bytes:new Uint8Array()}), false);
});

test('exposed same-host redirects are validated before following, offsite and credential redirects stop', async () => {
  const calls = [];
  const media = await fetchExportMedia(url, {fetchImpl: async value => {
    calls.push(value);
    return calls.length === 1 ? new Response(null,{status:302,headers:{location:'https://wx2.sinaimg.cn/large/photo.png'}}) : new Response(png);
  }});
  assert.equal(media.mime, 'image/png');
  assert.deepEqual(calls,[url,'https://wx2.sinaimg.cn/large/photo.png']);
  for (const location of ['https://evil.test/a.png','https://u:p@wx2.sinaimg.cn/a.png','http://wx2.sinaimg.cn/a.png']) {
    let count = 0;
    await assert.rejects(fetchExportMedia(url, {fetchImpl:async()=>{count++;return new Response(null,{status:302,headers:{location}});}}), /不支持的地址/);
    assert.equal(count,1);
  }
  await assert.rejects(fetchExportMedia(url, {fetchImpl:async()=>({type:'opaqueredirect'})}), /无法安全核对的跳转/);
  let loops = 0;
  await assert.rejects(fetchExportMedia(url, {fetchImpl:async()=>{loops++;return new Response(null,{status:302,headers:{location:'/loop'}});}}), /跳转次数过多/);
  assert.equal(loops,4);
});

test('unexpected effective response URL and HTML payload cannot become an image cache entry', async () => {
  const response = new Response(png);
  Object.defineProperty(response,'url',{value:'https://evil.test/photo.png'});
  await assert.rejects(fetchExportMedia(url,{fetchImpl:async()=>response}),/不支持的地址/);
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher('<html>Denied</html>',{headers:{'content-type':'image/png'}})}),/没有返回有效图片/);
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher(new Uint8Array())}),/没有返回有效图片/);
});

test('declared and streamed per-image size limits are enforced and oversized stream is cancelled', async () => {
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher(png,{headers:{'content-length':String(MAX_MEDIA_BYTES+1)}})}),/12 MiB/);
  let cancelled = false;
  const stream = new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES+1));},cancel(){cancelled=true;}});
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher(stream)}),/12 MiB/);
  assert.equal(cancelled,true);
});

test('HTTP restrictions, network failure and timeout are actionable and distinct', async () => {
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher('denied',{status:403})}),/HTTP 403.*重新加载/);
  await assert.rejects(fetchExportMedia(url,{fetchImpl:fetcher('missing',{status:404})}),/HTTP 404/);
  await assert.rejects(fetchExportMedia(url,{fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),/网络读取失败/);
  await assert.rejects(fetchExportMedia(url,{timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
  })}),/读取超时/);
});
