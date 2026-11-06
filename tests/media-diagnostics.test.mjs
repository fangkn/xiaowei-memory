import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaFailureDetails, enrichMediaFailures, formatExportFailures} from '../extension/media-diagnostics.js';
import {normalizeExportMediaURL} from '../extension/media-data.js';

test('shared media retains each source post while repeated references are deduplicated', () => {
  const url = '//wx1.sinaimg.cn/large/shared.jpg';
  const posts = ['One', 'Two'].map(id => ({id, url: `https://weibo.com/1234567890/${id}`, images: [url, url]}));
  const details = enrichMediaFailures(mediaFailureDetails(posts, [{url, reason: 'download failed'}]), [], normalizeExportMediaURL);
  assert.equal(details.length, 2);
  assert.deepEqual(details.map(item => item.postId), ['One', 'Two']);
  assert.equal(details[0].url, url);
  assert.equal(details[0].requestUrl, `https:${url}`);
});

test('version image failures remain attributable to the original post', () => {
  const url = 'http://wx1.sinaimg.cn/large/old.jpg';
  const details = mediaFailureDetails([{id: 'One', url: 'https://weibo.com/1234567890/One', images: [], versions: [{images: [url]}]}], [{url, reason: 'missing'}], {includeVersions: true});
  assert.equal(details.length, 1);
  assert.equal(details[0].postId, 'One');
  assert.equal(details[0].postUrl, 'https://weibo.com/1234567890/One');
});

test('formatting keeps full diagnostics as literal text without hiding unsafe input', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const output = formatExportFailures([{month: '2018-10', reason: '2 failures', attachments: [
    {postId: 'One', postUrl: 'javascript:alert(1)', url: unsafe, requestUrl: '', kind: 'image', reason: 'unsupported'},
    {postId: 'Two', postUrl: 'https://weibo.com/1234567890/Two', url: '', kind: 'unicode', reason: 'cannot draw 🦄'},
  ]}]);
  assert.ok(output.includes(unsafe));
  assert.ok(output.includes('javascript:alert(1)'));
  assert.match(output, /本机绘制，无远程图片地址/);
  assert.match(output, /微博 One/);
  assert.match(output, /微博 Two/);
});
