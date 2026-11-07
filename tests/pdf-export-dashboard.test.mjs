import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as model from '../extension/model.js';
import * as monthly from '../extension/monthly.js';
import {buildArchiveEntries, buildZip} from '../extension/archive.js';
import {createWizardState, transitionWizard, isWizardBusy} from '../extension/wizard-state.js';
import * as exportRunner from '../extension/export-runner.js';
import * as mediaData from '../extension/media-data.js';
import * as mediaDiagnostics from '../extension/media-diagnostics.js';

const source = readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const browserExportSource = readFileSync(new URL('../extension/browser-export.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const UID = '1234567890';
const imageUrl = 'https://wx1.sinaimg.cn/large/current.jpg';
const versionImageUrl = 'https://wx1.sinaimg.cn/large/historical.jpg';
function post(id, month = '2026-11', extra = {}) {
  return {uid: UID, id, key: `${UID}:${id}`, author: '测试账号', text: `原创正文 ${id}`,
    createdAt: `${month}-01T02:00:00.000Z`, url: `https://weibo.com/${UID}/${id}`,
    isRepost: false, repostText: '', repostUrl: '', images: [], versions: [],
    fullText: true, contentHash: id, identitySource: 'desktop-permalink', ...extra};
}

// Execute the production export functions; mock only browser/DB boundaries and PDF drawing.
function harness({posts = [post('Own1')], selection = '2026-11', images = false,
  format = 'pdf', pdfFailures = 0, unicodeFailures = 0, failedMediaUrls = [], attachmentFailures, pdfFailureMonth = '', fetchFailure = false, downloadFailure = false,
  downloadState = 'complete', failLedgerOnce = false, missingExportAPIs = false,
  permissionGranted = true, bridgeError = '', missingRuntime = false,
  contextInvalidated = false, invalidateDuringMonth = '', lockUnavailable = false} = {}) {
  const nodes = new Map(), settings = new Map(), calls = {pdfs: [], fetches: [], downloads: [], blobs: [], writes: [], reads: [], messages: [], permissions: [], operations: []};
  const fileStores = new Map();
  const openFiles = async job => {
    if (!fileStores.has(job.storageId)) fileStores.set(job.storageId, new Map());
    const entries = fileStores.get(job.storageId);
    return {
      async put(name, bytes) { entries.set(name, new Blob([bytes])); return {size: bytes.length}; },
      async get(name) { return entries.get(name) || null; },
      async remove(name) { entries.delete(name); },
      async createWritable(name) {
        const chunks = [];
        return {async write(bytes) { chunks.push(bytes.slice()); }, async close() { entries.set(name, new Blob(chunks)); }, async abort() { chunks.length = 0; }};
      },
      async cleanup() { entries.clear(); fileStores.delete(job.storageId); },
    };
  };
  function element(id) {
    return {id, value: '', textContent: '', disabled: false, hidden: false, checked: false, options: [], dataset: {},
      setAttribute(name, value) { this[name] = value; },
      replaceChildren(...children) { this.options = children; this.value = children[0]?.value || ''; },
      append(child) { this.options.push(child); if (!this.value) this.value = child.value; }};
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  $('format').value = format;
  $('batch').value = selection;
  $('batch').options = [{value: 'all'}, {value: '2026-10'}, {value: '2026-11'}];
  $('images').checked = images;
  let state = transitionWizard(createWizardState(), {type: 'SAVED', count: posts.length});
  state = transitionWizard(state, {type: 'OPEN_EXPORT'});
  const ui = {get state() { return state; }, dispatch(event) { state = transitionWizard(state, event); return state; },
    setActivity() {}, render() {}, setSavedCount(count) { state = transitionWizard(state, {type: 'SAVED', count}); }};
  class MockURL extends URL {
    static createObjectURL(blob) { calls.blobs.push(blob); return `blob:mock/${calls.blobs.length}`; }
    static revokeObjectURL() {}
  }
  const downloads = {
    async download(options) { calls.downloads.push(options); if (downloadFailure) throw new Error('download cancelled'); return 41 + calls.downloads.length; },
    async search() { return [{state: downloadState}]; },
  };
  const context = vm.createContext({
    ...model, ...monthly, ...exportRunner, ...mediaData, ...mediaDiagnostics, buildArchiveEntries, buildZip, isWizardBusy,
    runExportJob: (input, deps) => exportRunner.runExportJob(input, {...deps, openFiles}),
    cleanupExportJob: async job => { await (await openFiles(job)).cleanup(); },
    navigator: {locks: {request: async (_name, _options, callback) => callback(lockUnavailable ? null : {})}},
    setupPanelUI: () => ui, embedded: false,
    location: {href: 'https://extension.invalid/dashboard.html?tab=1'},
    document: {getElementById: $, createElement: tag => element(tag)},
    URL: MockURL, Blob, Uint8Array, Map, Set, TextEncoder, TextDecoder, Date, crypto,
    setTimeout() {}, console,
    async buildCombinedPdf(batches, options) {
      return context.buildMonthlyPdf({uid: UID, month: 'combined', posts: batches.flatMap(batch => batch.posts)}, options);
    },
    async buildMonthlyPdf(batch, options) {
      calls.pdfs.push({batch: structuredClone(batch), options: {images: options.images, urls: [...options.media.keys()]}});
      if (batch.month === invalidateDuringMonth) contextInvalidated = true;
      if (batch.month === pdfFailureMonth) throw new Error('PDF generation failed');
      return {bytes: new TextEncoder().encode(`%PDF-1.7\n${batch.month}\n%%EOF`),
        pageCount: 1, savedImageCount: options.media.size,
        failedImageCount: typeof pdfFailures === 'function' ? pdfFailures(batch) : pdfFailures,
        failedUnicodeEmojiCount: unicodeFailures,
        failedMediaUrls: typeof failedMediaUrls === 'function' ? failedMediaUrls(batch) : failedMediaUrls,
        attachmentFailures: typeof attachmentFailures === 'function' ? attachmentFailures(batch) : attachmentFailures};
    },
    db: {
      async mergeSetting(key, entries) {
        await this.put('settings', {...settings.get(key), ...entries}, key);
      },
      async get(store, key) { calls.operations.push('db-read'); calls.reads.push({store, key}); return structuredClone(settings.get(key)); },
      async all(store) { assert.equal(store, 'posts'); return structuredClone(posts); },
      async put(store, value, key) {
        if (store === 'settings' && key?.startsWith('exported-months:')) {
          if (failLedgerOnce) { failLedgerOnce = false; throw new Error('ledger unavailable'); }
          calls.writes.push({key, value: structuredClone(value)});
        }
        settings.set(key || (store === 'media' ? value.url : key), structuredClone(value));
      },
      async remove(store, key) { settings.delete(key); },
    },
    chrome: {
      permissions: missingExportAPIs ? undefined : {async request(options) { calls.permissions.push(options); return permissionGranted; }},
      downloads: missingExportAPIs ? undefined : downloads,
      runtime: missingRuntime ? undefined : {
        get id() { return contextInvalidated ? undefined : 'test-extension'; },
        getManifest() { if (contextInvalidated) throw new Error('Extension context invalidated.'); return {version: '0.6.9'}; },
        async sendMessage(message) {
        calls.messages.push(structuredClone(message)); calls.operations.push(message.type);
        if (bridgeError) return {ok: false, error: bridgeError};
        if (message.type === 'WOB_EXPORT_PERMISSION') return {ok: true, granted: permissionGranted};
        if (message.type === 'WOB_EXPORT_DOWNLOAD') {
          try { return {ok: true, downloadId: await downloads.download({url: message.url, filename: message.filename, saveAs: message.saveAs})}; }
          catch { return {ok: false, error: '下载未能开始，请重试。'}; }
        }
        if (message.type === 'WOB_EXPORT_DOWNLOAD_STATE') return {ok: true, state: (await downloads.search())[0].state};
        throw new Error('unexpected export message');
      }},
    },
    __fetchMedia: async url => {
      calls.fetches.push(url);
      if (typeof fetchFailure === 'function' ? fetchFailure(url) : fetchFailure) throw new Error('image unavailable');
      return {url, bytes: new Uint8Array([255, 216, 255, 217]), mime: 'image/jpeg'};
    },
  });
  const end = source.indexOf('function on(');
  assert.ok(end > 0, 'production business functions must precede event wiring');
  vm.runInContext(browserExportSource, context);
  vm.runInContext(source.slice(0, end).replace(/^import .*;\r?\n/gm, ''), context);
  vm.runInContext(`uid = '${UID}'; fetchMedia = __fetchMedia; refresh = async () => {};`, context);
  return {ui, $, calls, settings, fileStores,
    run: () => vm.runInContext('doExport()', context),
    reopen: () => vm.runInContext('openExport()', context),
    confirm: () => vm.runInContext('confirmExport()', context),
    pending: () => vm.runInContext('pendingExport', context),
    options: () => vm.runInContext('options()', context),
    setDownloadState: value => { downloadState = value; },
    invalidateContext: () => { contextInvalidated = true; },
    clearPdfFailure: () => { pdfFailureMonth = ''; },
    clearMediaFailure: () => { pdfFailures = 0; failedMediaUrls = []; attachmentFailures = []; fetchFailure = false; },
  };
}

async function zipEntries(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  const result = [];
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  for (let offset = view.getUint32(end + 16, true); offset < end;) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 10, true), 0);
    const size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true), start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    result.push({name: new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength)), data: bytes.slice(start, start + size)});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

test('a stale panel stops both text and image exports before any database read or file generation', async () => {
  for (const images of [false, true]) {
    const h = harness({contextInvalidated: true, images});
    await assert.rejects(h.run(), error => error.code === 'EXTENSION_CONTEXT_INVALIDATED' && /刷新微博/.test(error.message));
    assert.equal(h.calls.reads.length, 0);
    assert.equal(h.calls.pdfs.length, 0);
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.calls.permissions.length, 0);
    assert.equal(h.pending(), null);
    assert.equal(h.ui.state.phase, 'idle');
    assert.match(h.$('exportStatus').textContent, /已保存.*保留/);
    assert.doesNotMatch(h.$('exportStatus').textContent, /Extension context invalidated/);
  }
});

test('invalidation during a month stops the following month and never downloads or records an incomplete bundle', async () => {
  const h = harness({selection: 'all', posts: [post('OwnNov'), post('OwnOct', '2026-10')], invalidateDuringMonth: '2026-10'});
  await assert.rejects(h.run(), /刷新微博/);
  assert.equal(h.calls.pdfs.length, 1);
  assert.equal(h.calls.pdfs[0].batch.month, '2026-10');
  assert.equal(h.calls.blobs.length, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.pending(), null);
  assert.equal(h.ui.state.phase, 'idle');
});

test('a stale panel cannot confirm a previously started download or write its completion ledger', async () => {
  const h = harness();
  await h.run();
  h.invalidateContext();
  await assert.rejects(h.confirm(), /刷新微博/);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.ui.state.phase, 'downloaded');
  assert.ok(h.pending());
  assert.doesNotMatch(h.$('exportStatus').textContent, /Extension context invalidated/);
});

test('missing panel permissions and downloads APIs export images through the background and confirm only when complete', async () => {
  const h = harness({missingExportAPIs: true, images: true, posts: [post('Own1', '2026-11', {images: [imageUrl]})]});
  const exporting = h.run();
  assert.deepEqual(h.calls.messages, [{type: 'WOB_EXPORT_PERMISSION'}], 'permission message must be sent synchronously in the click handler');
  assert.equal(h.calls.reads.length, 0, 'permission request must precede any awaited storage operation');
  await exporting;
  assert.equal(h.calls.pdfs[0].options.images, true);
  assert.deepEqual(h.calls.pdfs[0].options.urls, [imageUrl]);
  assert.equal(h.calls.messages[1].type, 'WOB_EXPORT_DOWNLOAD');
  assert.equal(h.pending().downloadId, 42);
  h.setDownloadState('in_progress');
  await assert.rejects(h.confirm(), /下载完成/);
  assert.equal(h.calls.writes.length, 0);
  h.setDownloadState('complete');
  await h.confirm();
  assert.equal(h.ui.state.phase, 'done');
  assert.equal(h.calls.writes.length, 1);
});

test('permission denial stops before generating files and can be retried without images', async () => {
  const h = harness({missingExportAPIs: true, images: true, permissionGranted: false});
  await assert.rejects(h.run(), /未获得新浪图片读取权限/);
  assert.equal(h.calls.pdfs.length, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.pending(), null);
  assert.equal(h.ui.state.phase, 'idle');
  assert.match(h.$('exportStatus').textContent, /取消“包含图片”/);
  h.$('images').checked = false;
  await h.run();
  await h.confirm();
  assert.equal(h.ui.state.phase, 'done');
  assert.equal(h.calls.messages.filter(message => message.type === 'WOB_EXPORT_PERMISSION').length, 1);
});

test('text-only exports do not request optional image permission even when the panel API is absent', async () => {
  const h = harness({missingExportAPIs: true});
  await h.run();
  assert.deepEqual(h.calls.messages.map(message => message.type), ['WOB_EXPORT_DOWNLOAD', 'WOB_EXPORT_DOWNLOAD_STATE']);
  assert.equal(h.calls.fetches.length, 0);
});

test('an unavailable background reports recovery instructions without a TypeError or successful export', async () => {
  for (const config of [{missingRuntime: true}, {bridgeError: '请重新加载扩展后重试。'}]) {
    const h = harness({missingExportAPIs: true, images: true, ...config});
    await assert.rejects(h.run(), /刷新微博|重新加载/);
    assert.doesNotMatch(h.$('exportStatus').textContent, /undefined|TypeError/);
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.ui.state.phase, 'idle');
  }
});

test('background download cancellation preserves a retryable export step and does not write a ledger', async () => {
  const h = harness({missingExportAPIs: true, downloadFailure: true});
  await assert.rejects(h.run(), /下载未能开始/);
  assert.equal(h.pending(), null);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.ui.state.phase, 'idle');
});

test('single-month PDF selection filters saved reposts and uses an independent ledger', async () => {
  const h = harness({posts: [post('Own1'), post('Repost1', '2026-11', {isRepost: true, repostText: '不要导出此转发'}), post('OwnOct', '2026-10')]});
  assert.equal(h.options().format, 'pdf');
  assert.equal(h.options().originalOnly, true);
  await h.run();
  assert.equal(h.calls.pdfs.length, 1);
  assert.deepEqual(h.calls.pdfs[0].batch.posts.map(p => p.id), ['Own1']);
  assert.equal(h.calls.blobs[0].type, 'application/pdf');
  assert.match(h.calls.downloads[0].filename, /2026-11.*\.pdf$/);
  assert.match(await h.calls.blobs[0].text(), /^%PDF-/);
  assert.equal(h.pending().ledgerKey, monthly.monthLedgerKey(UID, {format: 'pdf', originalOnly: true}));
  assert.equal(h.calls.writes.length, 0, 'download initiation alone must not mark export complete');
});

test('all-month export downloads one ZIP with one PDF per nonempty original month', async () => {
  const h = harness({selection: 'all', posts: [post('OwnNov'), post('OwnOct', '2026-10'), post('OnlyRepost', '2026-09', {isRepost: true})]});
  await h.run();
  assert.deepEqual(h.calls.pdfs.map(p => p.batch.month), ['2026-10', '2026-11']);
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(h.calls.blobs[0].type, 'application/zip');
  const pdfs = (await zipEntries(h.calls.blobs[0])).filter(entry => entry.name.endsWith('.pdf'));
  assert.equal(pdfs.length, 2);
  assert.ok(pdfs.some(entry => /2026-10-originals\.pdf$/.test(entry.name)));
  assert.ok(pdfs.some(entry => /2026-11-originals\.pdf$/.test(entry.name)));
  assert.ok(pdfs.every(entry => new TextDecoder().decode(entry.data).startsWith('%PDF-')));
  assert.deepEqual(Array.from(h.pending().batches, batch => batch.month), ['2026-10', '2026-11']);
});

test('combined PDF downloads once, filters reposts, and confirms all selected months in its own ledger', async () => {
  const h = harness({format: 'pdf-combined', selection: 'all', posts: [post('OwnNov'), post('OwnOct', '2026-10'), post('Repost', '2026-10', {isRepost: true}), post('Other', '2026-11', {uid: '9999999999'})]});
  await h.run();
  assert.equal(h.calls.pdfs.length, 1);
  assert.deepEqual(h.calls.pdfs[0].batch.posts.map(p => p.id), ['OwnOct', 'OwnNov']);
  assert.equal(h.calls.downloads.length, 1);
  assert.match(h.calls.downloads[0].filename, /\.pdf$/);
  assert.equal(h.calls.blobs[0].type, 'application/pdf');
  assert.match(h.$('exportStatus').textContent, /一个 PDF/);
  assert.doesNotMatch(h.$('exportStatus').textContent, /ZIP|解压/);
  assert.equal(h.calls.writes.length, 0);
  const key = monthly.monthLedgerKey(UID, {format: 'pdf-combined', originalOnly: true});
  assert.equal(h.pending().ledgerKey, key);
  await h.confirm();
  assert.equal(h.ui.state.phase, 'done');
  assert.deepEqual(Object.keys(h.settings.get(key)), ['2026-10', '2026-11']);
  assert.equal(h.settings.has(monthly.monthLedgerKey(UID, {format: 'pdf', originalOnly: true})), false);
});

test('combined PDF keeps previously exported months and respects the chosen month range', async () => {
  const posts = [post('OwnNov'), post('OwnOct', '2026-10'), post('OwnSep', '2026-09')];
  const h = harness({format: 'pdf-combined', selection: 'all', posts});
  h.$('from').value = '2026-10';
  h.$('to').value = '2026-11';
  h.$('incremental').checked = true;
  const batches = await monthly.selectMonthlyBatches(posts, {uid: UID, format: 'pdf-combined', originalOnly: true});
  h.settings.set(monthly.monthLedgerKey(UID, h.options()), Object.fromEntries(batches.map(batch => [batch.month, batch.revision])));
  await h.run();
  assert.deepEqual(h.calls.pdfs[0].batch.posts.map(p => p.id), ['OwnOct', 'OwnNov']);
  assert.deepEqual(Array.from(h.pending().batches, batch => batch.month), ['2026-10', '2026-11']);
});

test('combined PDF shares current image and emoticon preparation and requires complete attachments before confirmation', async () => {
  const face = 'https://wx1.sinaimg.cn/emoticon/smile.png';
  const h = harness({format: 'pdf-combined', selection: 'all', images: true, pdfFailures: 1, posts: [
    post('OwnNov', '2026-11', {images: [imageUrl], emoticons: [{text: '[笑]', url: face}], versions: [post('OwnNov', '2026-11', {images: [versionImageUrl]})]}),
    post('OwnOct', '2026-10', {images: [imageUrl]}),
  ]});
  await h.run();
  assert.deepEqual(h.calls.fetches, [imageUrl, face]);
  assert.equal(h.ui.state.canConfirm, false);
  assert.equal(h.pending().batches.length, 0, 'an incomplete combined PDF cannot confirm even a subset of its months');
  await assert.rejects(h.confirm(), /图片|附件/);
  assert.match(h.$('exportStatus').textContent, /重新生成合并 PDF/);
  h.clearMediaFailure();
  await h.run();
  assert.equal(h.calls.pdfs.length, 2);
  assert.equal(h.ui.state.canConfirm, true);
  await h.confirm();
  assert.equal(h.calls.writes.length, 1);
});

test('PDF image preparation reads current original images without fetching historical version images', async () => {
  const current = post('Own1', '2026-11', {images: [imageUrl], versions: [post('Own1', '2026-11', {images: [versionImageUrl], contentHash: 'old'})]});
  const h = harness({images: true, posts: [current]});
  await h.run();
  assert.deepEqual(h.calls.fetches, [imageUrl]);
  assert.deepEqual(h.calls.pdfs[0].options.urls, [imageUrl]);
  assert.equal(h.pending().hasFailures, false);
});

test('PDF image conversion failure prevents confirming a partial export', async () => {
  const h = harness({images: true, pdfFailures: 1, posts: [post('Own1', '2026-11', {images: [imageUrl]})]});
  await h.run();
  assert.equal(h.pending().hasFailures, true);
  assert.equal(h.ui.state.canConfirm, false);
  await assert.rejects(h.confirm(), /附件|图片/);
  assert.equal(h.calls.writes.length, 0);
  assert.notEqual(h.ui.state.phase, 'done');
});

test('failed image downloads cannot disappear from completion checks', async () => {
  const h = harness({images: true, fetchFailure: true, pdfFailures: 1, failedMediaUrls: [imageUrl], posts: [post('Own1', '2026-11', {images: [imageUrl]})]});
  await h.run();
  assert.equal(h.pending().hasFailures, true);
  assert.match(h.$('exportStatus').textContent, /image unavailable/);
  await assert.rejects(h.confirm(), /附件|图片/);
  assert.equal(h.calls.writes.length, 0);
});

test('multi-month confirmation waits for download completion and records every captured revision together', async () => {
  const h = harness({selection: 'all', posts: [post('OwnNov'), post('OwnOct', '2026-10')]});
  await h.run();
  const snapshot = structuredClone(h.pending());
  h.setDownloadState('in_progress');
  await assert.rejects(h.confirm(), /下载完成/);
  assert.equal(h.calls.writes.length, 0);
  h.setDownloadState('complete');
  await h.confirm();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].key, snapshot.ledgerKey);
  for (const batch of snapshot.batches) assert.equal(h.calls.writes[0].value[batch.month], batch.revision);
  assert.equal(h.ui.state.phase, 'done');
  assert.equal(h.pending(), null);
});

test('a failed multi-month ledger write preserves the PDF snapshot for retry', async () => {
  const h = harness({selection: 'all', failLedgerOnce: true, posts: [post('OwnNov'), post('OwnOct', '2026-10')]});
  await h.run();
  await assert.rejects(h.confirm(), /ledger unavailable/);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.pending().batches.length, 2);
  assert.equal(h.ui.state.phase, 'downloaded');
  await h.confirm();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.ui.state.phase, 'done');
});

test('cancelled PDF download leaves no confirmable snapshot or ledger entry', async () => {
  const h = harness({downloadFailure: true});
  await assert.rejects(h.run(), /download cancelled/);
  assert.equal(h.pending(), null);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.ui.state.phase, 'idle');
});

test('a repost-only month does not produce an empty or misleading PDF', async () => {
  const h = harness({posts: [post('OnlyRepost', '2026-11', {isRepost: true})]});
  await assert.rejects(h.run(), /没有|为空/);
  assert.equal(h.calls.pdfs.length, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.ui.state.phase, 'idle');
});

test('a failed month preserves generated files and retries only the failed month before making one complete ZIP', async () => {
  const h = harness({selection: 'all', pdfFailureMonth: '2026-11', posts: [post('OwnNov'), post('OwnOct', '2026-10')]});
  await h.run();
  assert.equal(h.calls.pdfs.length, 2);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.pending().hasFailures, true);
  assert.equal(h.ui.state.canConfirm, false);
  assert.match(h.$('exportStatus').textContent, /2026-11.*PDF generation failed/);
  assert.equal(h.calls.writes.length, 0);
  h.clearPdfFailure();
  await h.run();
  assert.deepEqual(h.calls.pdfs.map(item => item.batch.month), ['2026-10', '2026-11', '2026-11']);
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(h.pending().hasFailures, false);
  assert.equal(h.ui.state.canConfirm, true);
  assert.equal(h.$('exportProgress').value, h.$('exportProgress').max);
  await h.confirm();
  assert.equal(Object.keys(h.calls.writes[0].value).length, 2);
});

test('87 months produce one ZIP with all 87 PDFs and all revisions confirmed', async () => {
  const posts = Array.from({length: 87}, (_, i) => post(`Own${i}`, new Date(Date.UTC(2019, i, 1)).toISOString().slice(0, 7)));
  const h = harness({selection: 'all', posts, missingExportAPIs: true});
  await h.run();
  assert.equal(h.calls.pdfs.length, 87);
  assert.equal(new Set(h.calls.pdfs.map(item => item.batch.month)).size, 87);
  assert.equal(h.calls.downloads.length, 1);
  assert.ok(h.calls.downloads.every(download => download.saveAs === true));
  const pdfs = (await zipEntries(h.calls.blobs[0])).filter(entry => entry.name.endsWith('.pdf'));
  assert.equal(pdfs.length, 87);
  assert.equal(h.pending().downloadIds.length, 1);
  assert.equal(h.pending().batches.length, 87);
  assert.equal(h.$('exportProgress').value, 89);
  assert.equal(h.$('exportProgress').max, 89);
  assert.equal(h.$('exportProgressPercent').textContent, '100%');
  assert.equal(h.calls.writes.length, 0);
  await h.confirm();
  assert.equal(h.calls.messages.filter(message => message.type === 'WOB_EXPORT_DOWNLOAD_STATE').length, 2);
  assert.equal(Object.keys(h.calls.writes[0].value).length, 87);
  assert.equal(h.ui.state.phase, 'done');
  assert.equal(h.fileStores.size, 0, 'manual confirmation releases temporary monthly files');
});

test('another active export prevents concurrent writes to shared export checkpoints', async () => {
  const h = harness({lockUnavailable: true});
  await assert.rejects(h.run(), /另一个.*正在导出/);
  assert.equal(h.calls.pdfs.length, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.reads.length, 0);
});

test('PDF preparation fetches inline Weibo emoticons in addition to photos', async () => {
  const validEmoticonUrl = 'https://h5.sinaimg.cn/emoticon/face.png';
  const h = harness({images: true, posts: [post('Own1', '2026-11', {text: '散步 [笑cry]', images: [imageUrl], emoticons: [{text: '[笑cry]', url: validEmoticonUrl}]})]});
  await h.run();
  assert.deepEqual(h.calls.fetches, [imageUrl, validEmoticonUrl]);
  assert.deepEqual(h.calls.pdfs[0].options.urls, [imageUrl, validEmoticonUrl]);
  assert.equal(h.pending().hasFailures, false);
});

test('a failed alternative emoticon URL does not block a PDF whose inline emoticon rendered successfully', async () => {
  const obsolete = 'https://h5.sinaimg.cn/emoticon/old.png', current = 'https://h5.sinaimg.cn/emoticon/new.png';
  const h = harness({images: true, fetchFailure: url => url === obsolete, posts: [post('Own1', '2026-11', {
    text: '[笑cry]', emoticons: [{text: '[笑cry]', url: obsolete}, {text: '[笑cry]', url: current}]
  })]});
  await h.run();
  assert.deepEqual(h.calls.pdfs[0].options.urls, [current]);
  assert.equal(h.pending().hasFailures, false);
  await h.confirm();
  assert.equal(h.ui.state.phase, 'done');
});

test('Unicode emoji render failures block successful confirmation even without image permission', async () => {
  const h = harness({unicodeFailures: 1, images: false, posts: [post('Own1', '2026-11', {text: '散步 👍🏽'})]});
  await h.run();
  assert.equal(h.calls.permissions.length, 0);
  assert.equal(h.pending().hasFailures, true);
  await assert.rejects(h.confirm(), /表情/);
  assert.equal(h.calls.writes.length, 0);
});

test('undecodable cached images are removed so the next retry reads fresh image bytes', async () => {
  const h = harness({images: true, pdfFailures: 1, failedMediaUrls: [imageUrl], posts: [post('Own1', '2026-11', {images: [imageUrl]})]});
  h.settings.set(imageUrl, {url: imageUrl, mime: 'image/jpeg', bytes: new Uint8Array([255, 216, 255])});
  await h.run();
  assert.equal(h.calls.fetches.length, 0, 'header-valid cached file reaches the decoder first');
  assert.equal(h.settings.has(imageUrl), false, 'decoder rejected cache must be discarded');
  assert.equal(h.pending().hasFailures, true);
  h.clearMediaFailure();
  await h.run();
  assert.deepEqual(h.calls.fetches, [imageUrl]);
  assert.equal(h.pending().hasFailures, false);
  await h.confirm();
  assert.equal(h.ui.state.phase, 'done');
});

test('attachment details persist every affected post and reopening retries only the incomplete month', async () => {
  const legacy = 'http://wx1.sinaimg.cn/large/old.jpg?size=large&name=original';
  const h = harness({selection: 'all', images: true, fetchFailure: true,
    pdfFailures: batch => batch.month === '2026-11' ? 2 : 0,
    failedMediaUrls: batch => batch.month === '2026-11' ? [legacy] : [],
    posts: [post('CompleteOct', '2026-10'), post('FirstNov', '2026-11', {images: [legacy]}), post('SecondNov', '2026-11', {images: [legacy]})]});
  await h.run();
  const key = exportRunner.exportJobKey(UID, h.options());
  const saved = h.settings.get(key), attachments = saved.failures[0].attachments;
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map(item => item.postId), ['FirstNov', 'SecondNov']);
  assert.equal(attachments[0].url, legacy);
  assert.equal(attachments[0].requestUrl, legacy.replace('http:', 'https:'));
  assert.equal(attachments[0].postUrl, `https://weibo.com/${UID}/FirstNov`);
  assert.match(attachments[0].reason, /image unavailable/);
  assert.equal(h.$('exportFailures').hidden, false);
  await h.reopen();
  assert.equal(h.calls.pdfs.length, 2, 'restoring details never generates a PDF');
  assert.match(h.$('exportStatus').textContent, /保留 1 \/ 2/);
  assert.equal(h.$('export').dataset.resume, 'true');
  assert.match(h.$('exportFailureList').textContent, /FirstNov/);
  assert.match(h.$('exportFailureList').textContent, /SecondNov/);
  assert.ok(h.$('exportFailureList').textContent.includes(`图片地址：${legacy}`));
  assert.ok(h.$('exportFailureList').textContent.includes(`尝试地址：${legacy.replace('http:', 'https:')}`));
  h.clearMediaFailure();
  await h.run();
  assert.deepEqual(h.calls.pdfs.map(item => item.batch.month), ['2026-10', '2026-11', '2026-11']);
  assert.equal(h.$('exportFailures').hidden, true);
  assert.equal(h.$('exportFailureList').textContent, '');
  assert.match(h.$('exportProgressDetail').textContent, /已复用 1 个月/);
});

test('decoder diagnostics identify a missing photo without listing a recovered alternative emoticon', async () => {
  const obsolete = 'http://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/old.gif';
  const missing = 'https://wx1.sinaimg.cn/large/broken.jpg';
  const h = harness({images: true, pdfFailures: 1, failedMediaUrls: [obsolete, missing],
    fetchFailure: url => url === obsolete,
    attachmentFailures: [{postId: 'Own1', postUrl: `https://weibo.com/${UID}/Own1`, url: missing, kind: 'image', reason: '图片未能解码或嵌入 PDF。'}],
    posts: [post('Own1', '2026-11', {text: '[笑cry]', images: [missing], emoticons: [{text: '[笑cry]', url: obsolete}, {text: '[笑cry]', url: imageUrl}]})]});
  await h.run();
  assert.match(h.$('exportFailureList').textContent, /未能解码/);
  assert.ok(h.$('exportFailureList').textContent.includes(missing));
  assert.equal(h.$('exportFailureList').textContent.includes(obsolete), false);
});

test('failure details include all months rather than only the three summary lines', async () => {
  const posts = ['2026-08', '2026-09', '2026-10', '2026-11'].map((month, index) => post(`Missing${index}`, month, {images: [imageUrl]}));
  const h = harness({selection: 'all', images: true, fetchFailure: true, pdfFailures: 1, failedMediaUrls: [imageUrl], posts});
  await h.run();
  for (const item of posts) {
    assert.ok(h.$('exportFailureList').textContent.includes(item.createdAt.slice(0, 7)));
    assert.ok(h.$('exportFailureList').textContent.includes(item.url));
  }
  assert.match(h.$('exportFailureSummary').textContent, /4 个月.*4 个附件/);
});
