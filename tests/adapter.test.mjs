import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {normalizeExportMediaURL} from '../extension/media-data.js';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const sandbox = { URL, Date, module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { safeURL, permalink, profileUid, parseDate } = sandbox.module.exports;
const now = Date.parse('2026-11-01T09:00:00Z');

test('URLs require HTTPS and exact supported host boundaries', () => {
  assert.equal(safeURL('javascript:alert(1)'), null);
  assert.equal(safeURL('https://user:pass@weibo.com/u/12345'), null);
  assert.equal(safeURL('https://weibo.com.evil.test/x'), null);
  assert.equal(safeURL('http://wx1.sinaimg.cn/large/a.jpg'), null);
  assert.equal(safeURL('//wx1.sinaimg.cn/large/a.jpg'), 'https://wx1.sinaimg.cn/large/a.jpg');
});
test('permalinks and page UID remain strings and exclude non-profile routes', () => {
  assert.equal(permalink('https://weibo.com/1000000001/A1b2C3d4E?from=feed').id, 'A1b2C3d4E');
  assert.equal(permalink('/detail/12345678901234567'), null);
  assert.equal(permalink('/1000000001/12345678901234567'), null);
  assert.equal(permalink('https://example.com/1000000001/A1b2C3d4E'), null);
  assert.equal(profileUid('https://weibo.com/u/1000000001'), '1000000001');
  assert.equal(profileUid('https://weibo.com/1000000001'), '1000000001');
  assert.equal(profileUid('https://weibo.com/1000000001/A1b2C3d4E'), '');
  assert.equal(profileUid('https://weibo.com/n/someone'), '');
  assert.equal(profileUid('https://evil.com/u/1234567'), '');
  assert.equal(profileUid('https://sinaimg.cn/u/1234567'), '');
});
test('dates preserve Beijing interpretation and unknown dates remain null', () => {
  assert.equal(parseDate('2026-11-01 17:14', now), '2026-11-01T09:14:00.000Z');
  assert.equal(parseDate('2026-11-01T09:14:00.000Z', now), '2026-11-01T09:14:00.000Z');
  assert.equal(parseDate('26-11-1 17:14', now), '2026-11-01T09:14:00.000Z');
  assert.equal(parseDate('2026-02-30 12:00', now), null);
  assert.equal(parseDate('2026-11-01 25:10', now), null);
  assert.equal(parseDate('11-01', now), null);
  assert.equal(parseDate('来自 iPhone', now), null);
  assert.equal(parseDate('昨天 12:30', now), '2026-10-31T04:30:00.000Z');
  assert.equal(parseDate('5分钟前', now), '2026-11-01T08:55:00.000Z');
});

test('inline named emoticons retain safe source URLs separately from photos and preserve unsupported alt fallback', () => {
  const image = (alt, src, extra = {}) => ({getAttribute: key => ({alt, src})[key] || '', className:'emoji', closest:()=>null, ...extra});
  const good = image('[笑cry]','https://h5.sinaimg.cn/m/emoticon/icon/default/laugh.png');
  const hidden = image('[隐藏]','https://h5.sinaimg.cn/m/emoticon/hidden.png',{closest:()=>({})});
  const nodes = [good,good,hidden,image('[旧表情]','https://face.t.sinajs.cn/emoji.gif'),
    image('[坏地址]','https://user:secret@h5.sinaimg.cn/a.png'), image('[端口]','https://h5.sinaimg.cn:8443/a.png'),
    image('','https://wx1.sinaimg.cn/large/photo.png')];
  const result = sandbox.module.exports.emoticonsOf({querySelectorAll:()=>nodes});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),[{text:'[笑cry]',url:'https://h5.sinaimg.cn/m/emoticon/icon/default/laugh.png'},{text:'[旧表情]',url:'https://face.t.sinajs.cn/emoji.gif'}]);
});

test('DOM photo URL normalization matches export compatibility without weakening profile URLs', () => {
  for (const input of ['http://wx1.sinaimg.cn/large/a.jpg?old=1#hash', '//img.t.sinajs.cn/t4/face.gif',
    'http://face.t.sinajs.cn/t4/face.gif', 'https://face.t.sinajs.cn.evil.test/a.gif', 'http://weibo.com/u/123456',
    'https://wx1.sinaimg.cn:8443/a.jpg', 'http://user:secret@wx1.sinaimg.cn/a.jpg', '../a.jpg', 'data:image/png;base64,a']) {
    assert.equal(sandbox.module.exports.mediaURL(input), normalizeExportMediaURL(input));
  }
  assert.equal(safeURL('http://weibo.com/u/123456'), null);
  assert.equal(profileUid('http://weibo.com/u/123456'), '');
});
