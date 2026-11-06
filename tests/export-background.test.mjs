import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {EXPORT_MEDIA_ORIGINS, normalizeExportMediaURL} from '../extension/media-data.js';
import {createReferrerMediaReader, MEDIA_REFERRER_RULE_ID} from '../extension/media-referrer.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionURL = `chrome-extension://${extensionId}/`;
const blobURL = `blob:${extensionURL}11223344-5566-7788-99aa-bbccddeeff00`;
const filename = 'weibo-1000000001-2026-11-originals-2026-11-06T01-23-45-678Z.pdf';
const plain = value => JSON.parse(JSON.stringify(value));
const request = () => ({type: 'WOB_EXPORT_PERMISSION'});
const download = extra => ({type: 'WOB_EXPORT_DOWNLOAD', url: blobURL, filename, ...extra});
const state = downloadId => ({type: 'WOB_EXPORT_DOWNLOAD_STATE', downloadId});
const media = extra => ({type: 'WOB_EXPORT_MEDIA', url: 'https://wx1.sinaimg.cn/large/photo.png', ...extra});

function harness({permission = 'grant', downloadMode = 'success', searchMode = 'success',
  downloadId = 42, items = [{id: 42, byExtensionId: extensionId, state: 'complete'}], mediaGranted = true,
  mediaReader = async url => ({url, mime: 'image/png', bytes: new Uint8Array([137,80,78,71,13,10,26,10])})} = {}) {
  const calls = {permissions: [], permissionChecks: [], downloads: [], searches: [], relays: []}, handlers = {};
  const chrome = {
    declarativeNetRequest: {updateSessionRules: async options => {
      assert.deepEqual(Array.from(options.removeRuleIds), [MEDIA_REFERRER_RULE_ID]);
      if (options.addRules) assert.equal(options.addRules[0].condition.initiatorDomains[0], extensionId);
    }},
    runtime: {id: extensionId, getURL: path => extensionURL + path,
      onMessage: {addListener: fn => {handlers.message = fn;}}},
    action: {onClicked: {addListener: () => {}}},
    tabs: {sendMessage: async (...args) => {calls.relays.push(args); return {ok: true};}},
    permissions: {contains: async options => {calls.permissionChecks.push(plain(options)); return mediaGranted;}, request: options => {
      calls.permissions.push(plain(options));
      if (permission === 'throw') throw new Error('No user gesture');
      if (permission === 'reject') return Promise.reject(new Error('API rejected'));
      return Promise.resolve(permission === 'grant');
    }},
    downloads: {
      download: options => {
        calls.downloads.push(plain(options));
        if (downloadMode === 'throw') throw new Error('API unavailable');
        if (downloadMode === 'reject') return Promise.reject(new Error('User cancelled'));
        return Promise.resolve(downloadMode === 'undefined' ? undefined : downloadId);
      },
      search: options => {
        calls.searches.push(plain(options));
        if (searchMode === 'throw') throw new Error('API unavailable');
        if (searchMode === 'reject') return Promise.reject(new Error('Search unavailable'));
        return Promise.resolve(items);
      },
    },
  };
  if (permission === 'missing') delete chrome.permissions;
  if (downloadMode === 'missing') delete chrome.downloads;
  if (searchMode === 'missing') delete chrome.downloads.search;
  vm.runInNewContext(source, {chrome, URL, console, btoa, EXPORT_MEDIA_ORIGINS, normalizeExportMediaURL,
    createReferrerMediaReader: options => createReferrerMediaReader({...options, fetchMedia: mediaReader})});
  const sender = {id: extensionId, url: extensionURL + 'dashboard.html?embedded=1', frameId: 3,
    tab: {id: 99, url: 'https://weibo.com/u/1000000001'}};
  function invoke(message, origin = sender) {
    let keptAlive, answered = false;
    const response = new Promise(resolve => {
      keptAlive = handlers.message(message, origin, value => {answered = true; resolve(plain(value));});
      if (!keptAlive && !answered) resolve(undefined);
    });
    return {keptAlive, response};
  }
  return {calls, sender, invoke, message: (value, origin) => invoke(value, origin).response};
}

test('media permission is started synchronously and requests only the declared image host', async () => {
  const h = harness();
  const result = h.invoke({...request(), origins: ['https://evil.test/*'], permissions: ['history'], tabId: 100});
  assert.deepEqual(h.calls.permissions, [{origins: EXPORT_MEDIA_ORIGINS}], 'must call before handler yields');
  assert.equal(result.keptAlive, true);
  assert.deepEqual(await result.response, {ok: true, granted: true});
  assert.equal(h.calls.relays.length, 0);
});

test('media bridge upgrades known legacy sources and never forwards untrusted sinajs domains', async () => {
  const requested = [];
  const h = harness({mediaReader: async url => {requested.push(url); return {url, mime: 'image/png', bytes: new Uint8Array([137,80,78,71,13,10,26,10])};}});
  for (const source of ['http://wx1.sinaimg.cn/large/old.png', '//img.t.sinajs.cn/t4/face.gif', 'http://face.t.sinajs.cn/t4/face.png']) {
    assert.equal((await h.message(media({url:source}))).ok, true);
    assert.equal(requested.at(-1), normalizeExportMediaURL(source));
    assert.deepEqual(h.calls.permissionChecks.at(-1), {origins:[new URL(normalizeExportMediaURL(source)).origin + '/*']});
  }
  for (const source of ['https://evil.sinajs.cn/a.gif', 'https://face.t.sinajs.cn.evil.test/a.gif', 'http://u:p@img.t.sinajs.cn/a.gif']) {
    assert.equal((await h.message(media({url:source}))).ok, false);
  }
  assert.equal(requested.length, 3);
});

test('denied image permission is returned as denial rather than success or an exception', async () => {
  const h = harness({permission: 'deny'});
  assert.deepEqual(await h.message(request()), {ok: true, granted: false});
  assert.equal(h.calls.downloads.length, 0);
});

test('missing, throwing and rejected permission APIs return actionable errors', async () => {
  for (const permission of ['missing', 'throw', 'reject']) {
    const result = await harness({permission}).message(request());
    assert.equal(result.ok, false, permission);
    assert.match(result.error, /图片读取权限.*重新加载.*包含图片/, permission);
    assert.doesNotMatch(result.error, /undefined|Cannot read/, permission);
  }
});

test('all export routes reject foreign extensions, page scripts and invalid embedding origins', async () => {
  const h = harness();
  const invalid = [
    {...h.sender, id: 'other-extension'},
    {...h.sender, url: 'https://weibo.com/u/1000000001'},
    {...h.sender, url: extensionURL + 'dashboard.html.evil?embedded=1'},
    {...h.sender, url: extensionURL + 'other.html'},
    {...h.sender, frameId: 0},
    {...h.sender, tab: undefined},
    {...h.sender, tab: {id: '99', url: 'https://weibo.com/'}},
    {...h.sender, tab: {id: 99, url: 'http://weibo.com/'}},
    {...h.sender, tab: {id: 99, url: 'https://weibo.com.evil.test/'}},
    {...h.sender, tab: {id: 99, url: 'https://user:password@weibo.com/'}},
    {...h.sender, tab: {id: 99, url: 'https://weibo.com:8443/'}},
  ];
  for (const sender of invalid) {
    for (const value of [request(), download(), state(42), media()]) {
      const result = await h.message(value, sender);
      assert.equal(result.ok, false);
      assert.match(result.error, /来源无效/);
    }
  }
  assert.deepEqual(h.calls, {permissions: [], permissionChecks: [], downloads: [], searches: [], relays: []});
});

test('download bridge defaults to a save dialog and accepts explicit automatic batch downloads', async () => {
  const h = harness();
  const result = await h.message(download({saveAs: false, conflictAction: 'overwrite', headers: [{name: 'Cookie', value: 'x'}]}));
  assert.deepEqual(result, {ok: true, downloadId: 42});
  assert.deepEqual(h.calls.downloads, [{url: blobURL, filename, saveAs: false}]);
  assert.equal((await h.message(download())).ok, true);
  assert.deepEqual(h.calls.downloads[1], {url: blobURL, filename, saveAs: true});
  for (const month of ['unknown', 'monthly']) {
    const name = filename.replace('2026-11-originals', `${month}-originals`).replace('.pdf', '.zip');
    assert.equal((await h.message(download({filename: name}))).ok, true);
  }
  for (const part of ['001', '123456']) {
    const name = filename.replace('2026-11-originals', `monthly-part${part}`).replace('.pdf', '.zip');
    assert.equal((await h.message(download({filename: name, saveAs: false}))).ok, true);
  }
  for (const saveAs of [null, 0, 'false', {}]) assert.equal((await h.message(download({saveAs}))).ok, false);
});

test('download bridge refuses external URLs, foreign blobs and malformed blob tokens', async () => {
  const h = harness();
  const urls = [undefined, '', 'https://wx1.sinaimg.cn/large/a.jpg', 'data:application/pdf;base64,YQ==',
    'blob:https://weibo.com/11223344-5566-7788-99aa-bbccddeeff00',
    'blob:chrome-extension://different/11223344-5566-7788-99aa-bbccddeeff00',
    `${blobURL}?file=other`, `${blobURL}#fragment`, `${blobURL}/../else`, `blob:${extensionURL}invalid`];
  for (const url of urls) assert.equal((await h.message(download({url}))).ok, false, String(url));
  assert.equal(h.calls.downloads.length, 0);
});

test('download bridge refuses paths, unexpected formats and malformed generated filenames', async () => {
  const h = harness();
  const names = [undefined, '', `../${filename}`, `/tmp/${filename}`, `folder\\${filename}`, filename + '/x',
    filename.replace('.pdf', '.exe'), filename.replace('-2026-11-originals-', '-2026-13-originals-'),
    filename.replace('1000000001', 'abc'), filename.replace('T01-23', 'T99-23'), filename + '\n',
    filename.replace('2026-11-originals', 'monthly-part1').replace('.pdf', '.zip'),
    filename.replace('2026-11-originals', 'monthly-part1234567').replace('.pdf', '.zip'),
    filename.replace('2026-11-originals', 'monthly-part001')];
  for (const name of names) assert.equal((await h.message(download({filename: name}))).ok, false, String(name));
  assert.equal(h.calls.downloads.length, 0);
});

test('image bridge verifies optional permission and only returns bounded image payload fields', async () => {
  let reads = 0;
  const h = harness({mediaReader: async url => { reads++; return {url, mime:'image/png',bytes:Uint8Array.of(137,80,78,71,13,10,26,10)}; }});
  assert.deepEqual(await h.message(media({headers:{Cookie:'never forwarded'}, credentials:'include'})),
    {ok:true,mime:'image/png',base64:'iVBORw0KGgo='});
  assert.equal(reads, 1);
  for (const url of ['https://evil.test/a.png', 'http://untrusted.sinajs.cn/a.png', 'https://wx1.sinaimg.cn:8443/a', 'https://user:secret@wx1.sinaimg.cn/a']) {
    assert.equal((await h.message(media({url}))).ok, false);
  }
  assert.equal(reads, 1);
  const denied = harness({mediaGranted:false, mediaReader:async()=>{throw new Error('must not fetch');}});
  assert.match((await denied.message(media())).error, /图片权限/);
  assert.equal(denied.calls.permissions.length, 0, 'does not request permission without a user click');
  const failed = harness({mediaReader:async()=>{throw new Error('图片服务器拒绝读取（HTTP 403）');}});
  assert.match((await failed.message(media())).error, /403/);
});

test('missing, throwing and rejected download APIs do not produce a download ID', async () => {
  for (const downloadMode of ['missing', 'throw', 'reject']) {
    const result = await harness({downloadMode}).message(download());
    assert.equal(result.ok, false, downloadMode);
    assert.match(result.error, /下载.*重试/, downloadMode);
    assert.equal(result.downloadId, undefined);
  }
  assert.equal((await harness({downloadMode: 'undefined'}).message(download())).ok, false);
  for (const downloadId of [null, -1, '42', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await harness({downloadId}).message(download())).ok, false, String(downloadId));
  }
});

test('download state lookup reveals only state for this extension and exact ID', async () => {
  const h = harness({items: [{id: 42, byExtensionId: extensionId, state: 'complete', filename: '/private/user/file.pdf', url: blobURL}]});
  assert.deepEqual(await h.message({...state(42), query: ['secret'], url: 'https://evil.test/'}), {ok: true, state: 'complete'});
  assert.deepEqual(h.calls.searches, [{id: 42}]);
  for (const items of [[], [{id: 42, state: 'complete'}], [{id: 42, byExtensionId: 'other-extension', state: 'complete'}],
    [{id:42,byExtensionId:extensionId,state:'complete',exists:false}],
    [{id: 43, byExtensionId: extensionId, state: 'complete'}], [{id: 42, byExtensionId: extensionId, state: 'unexpected'}]]) {
    assert.deepEqual(await harness({items}).message(state(42)), {ok: true, state: 'unknown'});
  }
  for (const value of ['in_progress', 'interrupted']) {
    assert.deepEqual(await harness({items: [{id: 42, byExtensionId: extensionId, state: value}]}).message(state(42)), {ok: true, state: value});
    assert.deepEqual(await harness({items: [{id: 42, byExtensionId: extensionId, state: value, exists:false}]}).message(state(42)), {ok: true, state: value});
  }
});

test('invalid download IDs and unavailable state API cannot read download history', async () => {
  const h = harness();
  for (const id of [undefined, null, -1, '42', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await h.message(state(id))).ok, false, String(id));
  }
  assert.equal(h.calls.searches.length, 0);
  for (const searchMode of ['missing', 'throw', 'reject']) {
    const result = await harness({searchMode}).message(state(42));
    assert.equal(result.ok, false, searchMode);
    assert.match(result.error, /无法核对下载状态.*重试/);
  }
});
