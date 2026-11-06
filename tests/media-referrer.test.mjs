import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferrerMediaReader, mediaReferrerRule, MEDIA_REFERRER_RULE_ID} from '../extension/media-referrer.js';
import {fetchExportMedia} from '../extension/media-data.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const url = 'https://wx1.sinaimg.cn/large/photo.png';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nC8AAAAASUVORK5CYII=', 'base64'));

function harness({fetchMedia, failInstall = false, failCleanup = false, orphan = false} = {}) {
  const rules = new Map([[42, {id: 42, action: {type: 'block'}}]]), calls = [], fetched = [];
  if (orphan) rules.set(MEDIA_REFERRER_RULE_ID, mediaReferrerRule(extensionId));
  let installationCount = 0;
  const chromeApi = {runtime: {id: extensionId}, declarativeNetRequest: {async updateSessionRules(options) {
    calls.push(structuredClone(options));
    if (failInstall && options.addRules) throw new Error('installation rejected');
    if (failCleanup && installationCount && !options.addRules) throw new Error('cleanup rejected');
    for (const id of options.removeRuleIds) rules.delete(id);
    for (const rule of options.addRules || []) { rules.set(rule.id, rule); installationCount++; }
  }}};
  const reader = createReferrerMediaReader({chromeApi, fetchMedia: async value => {
    fetched.push(value);
    assert.ok(rules.has(MEDIA_REFERRER_RULE_ID), 'rule must stay installed until the complete image has been read');
    return fetchMedia ? fetchMedia(value) : {url: value, bytes: png, mime: 'image/png'};
  }});
  return {reader, calls, rules, fetched, chromeApi, recoverCleanup: () => { failCleanup = false; }};
}

test('referrer rule only affects this extension GET fetches to HTTPS Sinaimg', () => {
  const rule = mediaReferrerRule(extensionId);
  assert.equal(rule.id, MEDIA_REFERRER_RULE_ID);
  assert.deepEqual(rule.condition, {urlFilter: '|https://', requestDomains: ['sinaimg.cn', 'img.t.sinajs.cn', 'face.t.sinajs.cn'],
    initiatorDomains: [extensionId], resourceTypes: ['xmlhttprequest'], requestMethods: ['get']});
  assert.deepEqual(rule.action, {type: 'modifyHeaders', requestHeaders: [{header: 'Referer', operation: 'set', value: 'https://weibo.com/'}]});
  for (const id of ['', 'weibo.com', undefined]) assert.throws(() => mediaReferrerRule(id), /扩展连接无效/);
});

test('worker startup removes its orphan session rule without touching unrelated rules', async () => {
  const h = harness({orphan: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [{removeRuleIds: [MEDIA_REFERRER_RULE_ID]}]);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  assert.equal(h.rules.has(42), true);
});

test('request installs referrer before reading bytes and removes it after success', async () => {
  const h = harness();
  assert.equal((await h.reader(url)).mime, 'image/png');
  assert.equal(h.fetched.length, 1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].addRules.length, 1);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  assert.equal(h.rules.has(42), true);
});

test('the same 403-without-referrer response succeeds when the browser header rule is active', async () => {
  let installed = false, requests = 0;
  const fetchImpl = async (_value, init) => {
    requests++;
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    return installed ? new Response(png) : new Response('Forbidden', {status: 403});
  };
  await assert.rejects(fetchExportMedia(url, {fetchImpl}), /HTTP 403/);
  const reader = createReferrerMediaReader({chromeApi: {runtime: {id: extensionId},
    declarativeNetRequest: {async updateSessionRules(options) {
      if (options.removeRuleIds.includes(MEDIA_REFERRER_RULE_ID)) installed = false;
      if (options.addRules) {
        assert.equal(options.addRules[0].action.requestHeaders[0].value, 'https://weibo.com/');
        installed = true;
      }
    }}}, fetchMedia: value => fetchExportMedia(value, {fetchImpl})});
  assert.deepEqual((await reader(url)).bytes, png);
  assert.equal(requests, 2);
  assert.equal(installed, false);
});

test('read errors and timeouts clear the temporary rule and allow a later request', async () => {
  let first = true;
  const h = harness({fetchMedia: async value => {
    if (first) { first = false; throw new Error('图片读取超时'); }
    return {url: value, mime: 'image/png', bytes: png};
  }});
  await assert.rejects(h.reader(url), /图片读取超时/);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  assert.equal((await h.reader(url)).mime, 'image/png');
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
});

test('concurrent panels serialize reads so one cleanup cannot remove another active request rule', async () => {
  let finishFirst, firstArrived;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  const started = new Promise(resolve => { firstArrived = resolve; });
  let reads = 0;
  const h = harness({fetchMedia: async value => {
    reads++;
    if (reads === 1) { firstArrived(); await gate; }
    return {url: value, bytes: png, mime: 'image/png'};
  }});
  const first = h.reader(url), second = h.reader(url.replace('photo', 'second'));
  await started;
  assert.equal(reads, 1);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), true);
  assert.equal(h.calls.filter(call => call.addRules).length, 1);
  finishFirst();
  await Promise.all([first, second]);
  assert.equal(reads, 2);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  assert.equal(h.calls.filter(call => call.addRules).length, 2);
});

test('invalid media URLs and failed rule installation never issue a network request', async () => {
  const h = harness({failInstall: true});
  await assert.rejects(h.reader('https://evil.test/photo.png'), /地址无效/);
  await assert.rejects(h.reader(url), /重新加载.*图片权限/);
  assert.equal(h.fetched.length, 0);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  const absent = createReferrerMediaReader({chromeApi: {runtime: {id: extensionId}}, fetchMedia: () => assert.fail('must not fetch')});
  await assert.rejects(absent(url), /重新加载/);
});

test('cleanup failures are explicit and the next attempt atomically replaces the retained rule', async () => {
  const h = harness({failCleanup: true});
  await assert.rejects(h.reader(url), /设置未能恢复.*重新加载/);
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), true);
  h.recoverCleanup();
  assert.equal((await h.reader(url)).mime, 'image/png');
  assert.equal(h.rules.has(MEDIA_REFERRER_RULE_ID), false);
  assert.equal(h.rules.has(42), true);
});
