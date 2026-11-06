import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {MAX_MEDIA_BYTES, EXPORT_MEDIA_ORIGINS, usableExportMedia, normalizeExportMediaURL} from '../extension/media-data.js';

const source = readFileSync(new URL('../extension/browser-export.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const blobURL = `blob:chrome-extension://${extensionId}/11223344-5566-7788-99aa-bbccddeeff00`;
const filename = 'weibo-1000000001-2026-11-originals-2026-11-06T01-23-45-678Z.pdf';
const staleMessage = 'Extension context invalidated.';
const plain = value => JSON.parse(JSON.stringify(value));

function result(mode, value, message = staleMessage) {
  if (mode === 'throw') throw new Error(message);
  if (mode === 'reject') return Promise.reject(new Error(message));
  return Promise.resolve(value);
}

function harness({missingContext = '', manifestThrows = false, bridge = false,
  permissionMode = 'success', permissionGranted = true, downloadMode = 'success',
  searchMode = 'success', messageMode = 'success', failureMessage = staleMessage,
  mediaResponse = {ok:true,mime:'image/png',base64:'iVBORw0KGgo='}, downloadExists, downloadState = 'complete'} = {}) {
  const calls = {manifests: 0, permissions: [], downloads: [], searches: [], messages: []};
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest() {
        calls.manifests++;
        if (manifestThrows) throw new Error(staleMessage);
        return {version: '0.6.9'};
      },
      sendMessage(message) {
        calls.messages.push(plain(message));
        const response = message.type === 'WOB_EXPORT_PERMISSION' ? {ok: true, granted: permissionGranted}
          : message.type === 'WOB_EXPORT_MEDIA' ? mediaResponse : message.type === 'WOB_EXPORT_DOWNLOAD' ? {ok: true, downloadId: 42}
            : {ok: true, state: 'complete'};
        return result(messageMode, response, failureMessage);
      },
    },
    permissions: {request(options) {
      calls.permissions.push(plain(options));
      return result(permissionMode, permissionGranted, failureMessage);
    }},
    downloads: {
      download(options) {
        calls.downloads.push(plain(options));
        return result(downloadMode, 42, failureMessage);
      },
      search(query) {
        calls.searches.push(plain(query));
        return result(searchMode, [{id: 42, state: downloadState, exists:downloadExists}], failureMessage);
      },
    },
  };
  if (bridge) { delete chrome.permissions; delete chrome.downloads; }
  if (missingContext === 'runtime') delete chrome.runtime;
  if (missingContext === 'id') delete chrome.runtime.id;
  const context = vm.createContext({chrome: missingContext === 'chrome' ? undefined : chrome,
    atob, MAX_MEDIA_BYTES, EXPORT_MEDIA_ORIGINS, usableExportMedia, normalizeExportMediaURL});
  vm.runInContext(source, context);
  return {
    calls,
    assertContext: () => vm.runInContext('assertExtensionContext()', context),
    permission: () => vm.runInContext('requestImagePermission()', context),
    download: (extra = {}) => vm.runInContext(`downloadExport(${JSON.stringify({url: blobURL, filename, ...extra})})`, context),
    media: (url = 'https://wx1.sinaimg.cn/large/a.png') => vm.runInContext(`requestExportMedia(${JSON.stringify(url)})`, context),
    state: () => vm.runInContext('exportDownloadState(42)', context),
    normalize(error) { context.inputError = error; return vm.runInContext('normalizeExtensionError(inputError)', context); },
  };
}

function isStale(error) {
  assert.equal(error.code, 'EXTENSION_CONTEXT_INVALIDATED');
  assert.match(error.message, /刷新微博/);
  assert.match(error.message, /已保存.*(?:保留|仍在)/);
  assert.doesNotMatch(error.message, /Extension context invalidated|TypeError/);
  return true;
}

test('context preflight accepts a live runtime without invoking a permission or download', () => {
  const h = harness();
  assert.doesNotThrow(h.assertContext);
  assert.equal(h.calls.permissions.length + h.calls.downloads.length + h.calls.searches.length + h.calls.messages.length, 0);
});

test('missing Chrome runtime or runtime ID is reported as a stale panel before browser operations', async () => {
  for (const missingContext of ['chrome', 'runtime', 'id']) {
    const h = harness({missingContext});
    assert.throws(h.assertContext, isStale);
    for (const operation of [h.permission, h.download, h.state, h.media]) await assert.rejects(async () => operation(), isStale);
    assert.equal(h.calls.permissions.length + h.calls.downloads.length + h.calls.searches.length + h.calls.messages.length, 0);
  }
});

test('a retained runtime object whose getManifest fails is rejected before requesting permission', async () => {
  const h = harness({manifestThrows: true});
  assert.throws(h.assertContext, isStale);
  await assert.rejects(async () => h.permission(), isStale);
  assert.equal(h.calls.permissions.length, 0);
  assert.equal(h.calls.messages.length, 0);
});

test('direct image permission starts in the click call stack and preserves a real denial', async () => {
  const h = harness({permissionGranted: false});
  const pending = h.permission();
  assert.deepEqual(h.calls.permissions, [{origins: EXPORT_MEDIA_ORIGINS}]);
  assert.equal(await pending, false);
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.calls.downloads.length, 0);
});

test('direct permission API invalidation is normalized for both synchronous throws and promise rejections', async () => {
  for (const permissionMode of ['throw', 'reject']) {
    const h = harness({permissionMode});
    await assert.rejects(async () => h.permission(), isStale);
    assert.equal(h.calls.permissions.length, 1, 'must not silently retry a permission request');
    assert.equal(h.calls.downloads.length + h.calls.messages.length, 0);
  }
});

test('direct download and download-state invalidation never return a successful result', async () => {
  for (const mode of ['throw', 'reject']) {
    const download = harness({downloadMode: mode});
    await assert.rejects(async () => download.download(), isStale);
    assert.equal(download.calls.downloads.length, 1);
    assert.equal(download.calls.searches.length + download.calls.messages.length, 0);
    const search = harness({searchMode: mode});
    await assert.rejects(async () => search.state(), isStale);
    assert.equal(search.calls.searches.length, 1);
    assert.equal(search.calls.downloads.length + search.calls.messages.length, 0);
  }
});

test('background permission fallback is sent synchronously and denial remains false', async () => {
  const h = harness({bridge: true, permissionGranted: false});
  const pending = h.permission();
  assert.deepEqual(h.calls.messages, [{type: 'WOB_EXPORT_PERMISSION'}]);
  assert.equal(await pending, false);
});

test('all background export routes translate invalidated-context throws and rejections', async () => {
  for (const messageMode of ['throw', 'reject']) {
    for (const operation of ['permission', 'download', 'state', 'media']) {
      const h = harness({bridge: true, messageMode});
      await assert.rejects(async () => h[operation](), isStale);
      assert.equal(h.calls.messages.length, 1);
      assert.equal(h.calls.permissions.length + h.calls.downloads.length + h.calls.searches.length, 0);
    }
  }
});

test('both download paths honor boolean saveAs and refuse invalid types before starting', async () => {
  for (const bridge of [false,true]) {
    const h = harness({bridge});
    assert.equal(await h.download({saveAs:false}),42);
    assert.equal((bridge ? h.calls.messages : h.calls.downloads)[0].saveAs, false);
    for (const saveAs of [null, 'false', 0]) await assert.rejects(h.download({saveAs}), /下载方式无效/);
    assert.equal((bridge ? h.calls.messages : h.calls.downloads).length,1);
  }
});

test('image bridge decodes bytes and rejects invalid URLs, broken data, and cached error pages', async () => {
  const h = harness();
  const media = await h.media();
  assert.deepEqual([...media.bytes], [137,80,78,71,13,10,26,10]);
  assert.equal(media.mime, 'image/png');
  assert.deepEqual(h.calls.messages, [{type:'WOB_EXPORT_MEDIA',url:'https://wx1.sinaimg.cn/large/a.png'}]);
  for (const url of ['https://evil.test/a.png', 'https://wx1.sinaimg.cn:8443/a.png']) await assert.rejects(h.media(url), /地址无效/);
  assert.equal(h.calls.messages.length, 1);
  for (const mediaResponse of [{ok:true,mime:'image/png',base64:btoa('<html>Denied</html>')},
    {ok:true,mime:'image/jpeg',base64:'iVBORw0KGgo='}, {ok:true,mime:'image/png',base64:'invalid!'},
    {ok:false,error:'图片服务器拒绝读取（HTTP 403）'}]) {
    await assert.rejects(harness({mediaResponse}).media(), /图片/);
  }
});

test('legacy media requests use HTTPS while preserving original cache and PDF map keys', async () => {
  const h = harness();
  for (const original of ['http://wx1.sinaimg.cn/large/old.png?a=1', '//img.t.sinajs.cn/t4/face.gif', 'http://face.t.sinajs.cn/t4/face.png']) {
    const media = await h.media(original);
    assert.equal(media.url, original);
    assert.equal(media.resolvedUrl, normalizeExportMediaURL(original));
    assert.equal(h.calls.messages.at(-1).url, media.resolvedUrl);
  }
});

test('healthy direct and background download paths preserve download IDs and completion state', async () => {
  for (const bridge of [false, true]) {
    const h = harness({bridge});
    assert.equal(await h.download(), 42);
    assert.equal(await h.state(), 'complete');
    if (!bridge) assert.deepEqual(h.calls.downloads, [{url: blobURL, filename, saveAs: true}]);
  }
});

test('a deleted local download is unknown and cannot satisfy a resume checkpoint', async () => {
  assert.equal(await harness({downloadExists:false}).state(), 'unknown');
  assert.equal(await harness({downloadExists:true}).state(), 'complete');
});

test('an unfinished or interrupted download preserves its state when the destination does not exist yet', async () => {
  for (const downloadState of ['in_progress', 'interrupted']) {
    assert.equal(await harness({downloadExists:false,downloadState}).state(), downloadState);
  }
});

test('ordinary errors are not mislabeled as an extension reload', async () => {
  for (const message of ['Network request failed', 'User cancelled download']) {
    const h = harness({permissionMode: 'reject', downloadMode: 'reject', searchMode: 'reject', failureMessage: message});
    const error = h.normalize(new Error(message));
    assert.equal(error.message, message);
    assert.notEqual(error.code, 'EXTENSION_CONTEXT_INVALIDATED');
    for (const operation of [h.permission, h.download, h.state]) {
      await assert.rejects(async () => operation(), failure => {
        assert.equal(failure.message, message);
        assert.notEqual(failure.code, 'EXTENSION_CONTEXT_INVALIDATED');
        return true;
      });
    }
    const background = harness({bridge: true, messageMode: 'reject', failureMessage: message});
    await assert.rejects(async () => background.permission(), failure => {
      assert.notEqual(failure.code, 'EXTENSION_CONTEXT_INVALIDATED');
      return true;
    });
  }
});
