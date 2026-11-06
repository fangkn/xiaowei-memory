import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, openAsBlob, rmSync} from 'node:fs';
import {open, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {crc32} from '../extension/archive.js';
import {createExportJob, exportJobKey, matchesExportJob, generatedExportMonths, completedExportMonths, runExportJob} from '../extension/export-runner.js';

const UID = '1234567890', options = {format: 'pdf', images: true}, temporary = [];
after(() => { for (const directory of temporary) rmSync(directory, {recursive: true, force: true}); });
function batches(count = 3) {
  return Array.from({length: count}, (_, index) => {
    const month = new Date(Date.UTC(2018, index, 1)).toISOString().slice(0, 7);
    return {uid: UID, month, revision: `revision-${month}`, posts: [{uid: UID, id: `post-${index}`}]};
  });
}
function diskFiles() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xiaowei-export-test-')); temporary.push(directory);
  const calls = {writes: [], largestWrite: 0, cleanup: 0};
  return {directory, calls,
    async put(name, bytes) { calls.writes.push(name); await writeFile(path.join(directory, name), bytes); return {size: bytes.length}; },
    async get(name) {
      const file = path.join(directory, name);
      try { await stat(file); return await openAsBlob(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async remove(name) { await rm(path.join(directory, name), {force: true}); },
    async createWritable(name) {
      const file = await open(path.join(directory, name), 'w');
      let closed = false;
      return {
        async write(bytes) { calls.largestWrite = Math.max(calls.largestWrite, bytes.length); await file.write(bytes); },
        async close() { if (!closed) { closed = true; await file.close(); } },
        async abort() { if (!closed) { closed = true; await file.close(); } },
      };
    },
    async cleanup() { calls.cleanup++; await rm(directory, {recursive: true, force: true}); },
  };
}
function harness({months = batches(), job = createExportJob(UID, options, months), size = 4,
  failMonth = '', partialMonth = '', downloadStates = new Map(), files = diskFiles()} = {}) {
  const calls = {prepared: [], downloaded: [], queried: [], snapshots: [], progress: [], revoked: [], created: [], sleep: [], bytes: 0};
  const active = new Set(); let nextId = Math.max(0, ...job.downloads.map(item => item.downloadId || 0)) + 1, sequence = 0, invalid = false;
  const deps = {
    openFiles: async () => files,
    assertContext() { if (invalid) throw Object.assign(new Error('扩展已失效，请刷新微博'), {code: 'EXTENSION_CONTEXT_INVALIDATED'}); },
    async prepareMonth(batch) {
      assert.equal(active.size, 0, 'generation must not race an unfinished download');
      calls.prepared.push(batch.month);
      if (batch.month === failMonth) throw new Error('模拟本月生成失败');
      calls.bytes += size;
      return {bytes: new Uint8Array(size).fill(calls.prepared.length & 255), extension: 'pdf', mime: 'application/pdf', pageCount: 1,
        failedImageCount: batch.month === partialMonth ? 1 : 0, savedImageCount: batch.month === partialMonth ? 0 : 1};
    },
    async downloadFile(value) { const id = nextId++; calls.downloaded.push({...value, id}); return id; },
    async downloadState(id) { calls.queried.push(id); return downloadStates.get(id) || 'complete'; },
    async saveJob(value) {
      const serialized = JSON.stringify(value);
      assert.ok(!serialized.includes('"bytes"') && !serialized.includes('"posts"'), 'checkpoint must contain metadata only');
      calls.snapshots.push(JSON.parse(serialized));
    },
    createObjectURL(blob) { const url = `blob:mock/${++sequence}`; active.add(url); calls.created.push({url, size: blob.size, mime: blob.type}); assert.equal(active.size, 1); return url; },
    revokeObjectURL(url) { assert.ok(active.delete(url)); calls.revoked.push(url); },
    sleep: async ms => { calls.sleep.push(ms); },
    onProgress: value => { calls.progress.push(structuredClone(value)); },
  };
  return {job, months, calls, deps, active, downloadStates, files,
    run: () => runExportJob({job, batches: months, options}, deps), invalidate: () => { invalid = true; },
    fixMonth: () => { failMonth = ''; partialMonth = ''; },
  };
}
function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder(), end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true), entries = []; let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 8, true), 0x0808);
    const crc = view.getUint32(offset + 16, true), size = view.getUint32(offset + 24, true), length = view.getUint16(offset + 28, true);
    const name = text.decode(bytes.subarray(offset + 46, offset + 46 + length)), local = view.getUint32(offset + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true), data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc); assert.equal(view.getUint32(start + size, true), 0x08074b50);
    assert.equal(view.getUint32(start + size + 4, true), crc);
    entries.push({name, data}); offset += 46 + length;
  }
  assert.equal(offset, end); return entries;
}

test('job v2 binds account, media, format and exact month revisions without reusing old batch receipts', () => {
  const months = batches(), job = createExportJob(UID, options, months);
  assert.equal(exportJobKey(UID, options), `export-job:v2:pdf:images:${UID}`);
  assert.notEqual(exportJobKey(UID, options), exportJobKey(UID, {...options, images: false}));
  assert.notEqual(exportJobKey(UID, options), exportJobKey(UID, {...options, format: 'markdown'}));
  assert.equal(matchesExportJob(job, UID, options, months), true);
  assert.equal(matchesExportJob({...job, version: 1}, UID, options, months), false);
  assert.equal(matchesExportJob(job, '9876543210', options, months), false);
  assert.equal(matchesExportJob(job, UID, options, months.slice(1)), false);
  assert.equal(matchesExportJob(job, UID, options, months.map((month, i) => i ? month : {...month, revision: 'changed'})), false);
  assert.equal(matchesExportJob({...job, storageId: '../bad'}, UID, options, months), false);
  assert.throws(() => createExportJob(UID, options, [months[0], months[0]]), /快照无效/);
});

test('87 months exceeding 128 MiB write one disk-backed ZIP and download only once', async () => {
  const h = harness({months: batches(87), size: 2 * 1024 * 1024});
  await h.run();
  assert.equal(h.calls.bytes, 174 * 1024 * 1024);
  assert.equal(h.calls.prepared.length, 87); assert.equal(h.calls.downloaded.length, 1);
  assert.equal(h.calls.downloaded[0].saveAs, true); assert.match(h.calls.downloaded[0].filename, /-monthly-originals-.*\.zip$/);
  assert.equal(completedExportMonths(h.job).size, 87); assert.equal(generatedExportMonths(h.job).size, 87);
  assert.ok(h.calls.created[0].size > 174 * 1024 * 1024);
  assert.equal(h.calls.created[0].mime, 'application/zip');
  assert.ok(h.files.calls.largestWrite <= 1024 * 1024, 'streamed ZIP writes stay bounded');
  assert.equal(h.active.size, 0); assert.equal(h.calls.revoked.length, 1);
  const archive = await open(path.join(h.files.directory, 'archive.zip'), 'r');
  try {
    const length = (await archive.stat()).size, end = Buffer.alloc(22);
    await archive.read(end, 0, 22, length - 22);
    assert.equal(end.readUInt32LE(0), 0x06054b50); assert.equal(end.readUInt16LE(10), 88);
    const central = Buffer.alloc(end.readUInt32LE(12));
    await archive.read(central, 0, central.length, end.readUInt32LE(16));
    let offset = 0, pdfs = 0;
    while (offset < central.length) {
      assert.equal(central.readUInt32LE(offset), 0x02014b50);
      const nameLength = central.readUInt16LE(offset + 28), name = central.subarray(offset + 46, offset + 46 + nameLength).toString();
      if (name.endsWith('.pdf')) { pdfs++; assert.equal(central.readUInt32LE(offset + 24), 2 * 1024 * 1024); }
      offset += 46 + nameLength;
    }
    assert.equal(pdfs, 87);
  } finally { await archive.close(); }
  const progress = h.calls.progress.at(-1);
  assert.equal(progress.completed, 87); assert.equal(progress.generated, 87); assert.equal(progress.ready, 87); assert.equal(progress.phase, 'complete');
  assert.ok(h.calls.progress.filter(item => item.phase === 'packing').every(item => item.packedBytes <= item.totalBytes));
});

test('final ZIP contains exactly one PDF per month and an accurate manifest with valid CRCs', async () => {
  const h = harness(); await h.run();
  const entries = inspectZip(new Uint8Array(await readFile(path.join(h.files.directory, 'archive.zip'))));
  assert.equal(entries.filter(item => item.name.endsWith('.pdf')).length, 3);
  const manifest = JSON.parse(new TextDecoder().decode(entries.find(item => item.name === 'manifest.json').data));
  assert.equal(manifest.uid, UID); assert.equal(manifest.originalOnly, true); assert.equal(manifest.allHistoryGuaranteed, false);
  assert.deepEqual(manifest.months.map(item => item.month), h.months.map(item => item.month));
  assert.ok(!JSON.stringify(manifest).includes('revision-'));
});

test('single month remains one direct PDF with a single save dialog', async () => {
  const h = harness({months: batches(1)}); await h.run();
  assert.equal(h.calls.downloaded.length, 1); assert.equal(h.calls.downloaded[0].saveAs, true);
  assert.match(h.calls.downloaded[0].filename, /2018-01-originals-.*\.pdf$/);
  assert.equal(h.calls.created[0].mime, 'application/pdf'); assert.equal(await h.files.get('archive.zip'), null);
});

test('ZIP Blob remains alive until download completes and confirmation counts remain zero until then', async () => {
  const h = harness(); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  h.downloadStates.set(1, 'in_progress'); h.deps.sleep = async () => { arrived(); await gate; };
  const running = h.run(); await waiting;
  assert.equal(h.calls.prepared.length, 3); assert.equal(h.active.size, 1);
  assert.equal(h.calls.snapshots.at(-1).downloads[0].state, 'in_progress'); assert.equal(completedExportMonths(h.job).size, 0);
  h.downloadStates.set(1, 'complete'); release(); await running;
  assert.equal(h.active.size, 0); assert.equal(completedExportMonths(h.job).size, 3);
});

test('cancelled final download retains month files and retry repacks without regenerating', async () => {
  const h = harness({months: batches(5)}); h.downloadStates.set(1, 'interrupted');
  await assert.rejects(h.run(), error => error.code === 'EXPORT_DOWNLOAD_INTERRUPTED');
  assert.equal(completedExportMonths(h.job).size, 0); assert.equal(generatedExportMonths(h.job).size, 5);
  await h.run(); assert.equal(h.calls.prepared.length, 5); assert.equal(h.calls.downloaded.length, 2);
  assert.equal(completedExportMonths(h.job).size, 5);
});

test('render failure never downloads an archive missing a month and retry only generates the failed month', async () => {
  const months = batches(4), h = harness({months, failMonth: months[1].month});
  await h.run(); assert.equal(h.calls.downloaded.length, 0); assert.equal(generatedExportMonths(h.job).size, 3);
  assert.equal(h.calls.progress.at(-1).phase, 'partial'); assert.equal(h.calls.progress.at(-1).failedMonths, 1);
  h.fixMonth(); await h.run();
  assert.deepEqual(h.calls.prepared.slice(4), [months[1].month]);
  assert.equal(h.calls.downloaded.length, 1); assert.equal(completedExportMonths(h.job).size, 4);
});

test('missing images retain all PDFs with warnings and retry reuses complete month files', async () => {
  const months = batches(3), h = harness({months, partialMonth: months[1].month});
  await h.run(); assert.equal(h.calls.downloaded.length, 1); assert.equal(generatedExportMonths(h.job).size, 3);
  assert.equal(completedExportMonths(h.job).size, 2); assert.equal(h.calls.progress.at(-1).ready, 2);
  const entries = inspectZip(new Uint8Array(await readFile(path.join(h.files.directory, 'archive.zip'))));
  assert.equal(entries.filter(item => item.name.endsWith('.pdf')).length, 3);
  h.fixMonth(); await h.run();
  assert.deepEqual(h.calls.prepared.slice(3), [months[1].month]); assert.equal(h.calls.downloaded.length, 2);
  assert.equal(completedExportMonths(h.job).size, 3); assert.equal(h.calls.progress.at(-1).failedMonths, 0);
});

test('87-month checkpoint survives reload and retries only the three months with attachment failures', async () => {
  const months = batches(87), failed = new Set(['2018-10', '2018-12', '2019-01']);
  const h = harness({months}), prepare = h.deps.prepareMonth;
  const attachments = Array.from({length: 8}, (_, i) => ({postId: `Post${i}`, postUrl: `https://weibo.com/${UID}/Post${i}`,
    url: `http://wx1.sinaimg.cn/large/old-${i}.jpg`, requestUrl: `https://wx1.sinaimg.cn/large/old-${i}.jpg`, kind: 'image', reason: '图片读取失败（HTTP 404）'}));
  h.deps.prepareMonth = async batch => ({...await prepare(batch), ...(failed.has(batch.month) ? {failedImageCount: 8, savedImageCount: 0, attachmentFailures: attachments} : {})});
  await h.run();
  const saved = JSON.parse(JSON.stringify(h.calls.snapshots.at(-1)));
  assert.equal(saved.version, 2, 'upgrades must retain the existing job and OPFS directory format');
  assert.equal(saved.failures.length, 3);
  assert.deepEqual(saved.failures[0].attachments, attachments, 'all URLs and their owning posts survive checkpoint persistence');
  const entries = inspectZip(new Uint8Array(await readFile(path.join(h.files.directory, 'archive.zip'))));
  const manifest = JSON.parse(new TextDecoder().decode(entries.find(item => item.name === 'manifest.json').data));
  assert.deepEqual(manifest.failures[0].attachments, attachments);
  const completeBytes = new Map();
  for (const month of months.filter(month => !failed.has(month.month))) completeBytes.set(month.month, await readFile(path.join(h.files.directory, `${month.month}.pdf`)));
  const resumed = harness({months, job: saved, files: h.files});
  await resumed.run();
  assert.deepEqual(resumed.calls.prepared, [...failed]);
  assert.equal(resumed.calls.progress.find(item => item.phase === 'preparing').reused, 84);
  assert.equal(completedExportMonths(resumed.job).size, 87);
  assert.deepEqual(resumed.job.failures, []);
  for (const [month, bytes] of completeBytes) assert.deepEqual(await readFile(path.join(h.files.directory, `${month}.pdf`)), bytes);
  assert.equal(resumed.calls.downloaded.length, 1, 'retry downloads one rebuilt ZIP while retaining complete PDFs');
});

test('pre-upgrade v2 checkpoints without attachment details still reuse complete months', async () => {
  const months = batches(4), h = harness({months, partialMonth: months[1].month});
  await h.run();
  const saved = JSON.parse(JSON.stringify(h.job));
  for (const failure of saved.failures) delete failure.attachments;
  const resumed = harness({months, job: saved, files: h.files});
  assert.equal(matchesExportJob(saved, UID, options, months), true);
  await resumed.run();
  assert.deepEqual(resumed.calls.prepared, [months[1].month]);
  assert.equal(resumed.calls.progress.find(item => item.phase === 'preparing').reused, 3);
});

test('shareable ZIP diagnostics omit URL credentials and query tokens without mutating local failure details', async () => {
  const h = harness({partialMonth: '2018-01'}), prepare = h.deps.prepareMonth;
  const detail = {postId: 'Post', postUrl: `https://weibo.com/${UID}/Post?token=private#fragment`,
    url: 'http://wx1.sinaimg.cn/large/photo.jpg?token=private', requestUrl: 'https://user:private@wx1.sinaimg.cn/photo.jpg', kind: 'image', reason: '图片地址无效'};
  h.deps.prepareMonth = async batch => ({...await prepare(batch), attachmentFailures: [detail]});
  await h.run();
  assert.deepEqual(h.job.failures[0].attachments, [detail]);
  const entries = inspectZip(new Uint8Array(await readFile(path.join(h.files.directory, 'archive.zip'))));
  const json = new TextDecoder().decode(entries.find(item => item.name === 'manifest.json').data);
  assert.ok(!json.includes('private') && !json.includes('fragment'));
  const exported = JSON.parse(json).failures[0].attachments[0];
  assert.equal(exported.postUrl, `https://weibo.com/${UID}/Post`);
  assert.equal(exported.url, 'http://wx1.sinaimg.cn/large/photo.jpg');
  assert.equal(exported.requestUrl, '');
});

test('deleted download can be rebuilt from disk without regenerating valid months', async () => {
  const h = harness(); await h.run(); h.downloadStates.set(1, 'unknown');
  await h.run(); assert.equal(h.calls.prepared.length, 3); assert.equal(h.calls.downloaded.length, 2);
  assert.equal(completedExportMonths(h.job).size, 3);
});

test('missing or truncated month cache is regenerated after interrupted download', async () => {
  const h = harness(); h.downloadStates.set(1, 'interrupted'); await assert.rejects(h.run());
  await h.files.remove(`${h.months[1].month}.pdf`);
  await h.files.put(`${h.months[2].month}.pdf`, new Uint8Array(1));
  await h.run(); assert.deepEqual(h.calls.prepared.slice(3), h.months.slice(1).map(item => item.month));
  assert.equal(completedExportMonths(h.job).size, 3);
});

test('fully downloaded task checks receipt without touching already-cleaned temporary files', async () => {
  const h = harness(); await h.run(); await h.files.cleanup();
  h.deps.openFiles = async () => { throw new Error('must not access files'); };
  await h.run(); assert.equal(h.calls.downloaded.length, 1); assert.equal(h.calls.prepared.length, 3);
  assert.equal(h.calls.progress.at(-1).phase, 'complete');
});

test('unknown download state is bounded and never marked complete', async () => {
  const h = harness({months: batches(1)}); h.downloadStates.set(1, 'unknown');
  await assert.rejects(h.run(), error => error.code === 'EXPORT_DOWNLOAD_UNKNOWN');
  assert.equal(h.calls.queried.length, 10); assert.equal(completedExportMonths(h.job).size, 0); assert.equal(h.active.size, 0);
});

test('context invalidation preserves earlier generated months and stops before any download', async () => {
  const h = harness(), prepare = h.deps.prepareMonth;
  h.deps.prepareMonth = async month => { const result = await prepare(month); if (month.month === h.months[1].month) h.invalidate(); return result; };
  await assert.rejects(h.run(), error => error.code === 'EXTENSION_CONTEXT_INVALIDATED');
  assert.equal(h.calls.prepared.length, 2); assert.equal(generatedExportMonths(h.job).size, 1); assert.equal(h.calls.downloaded.length, 0);
});

test('month checkpoint failure stops before packaging and does not silently lose generated data', async () => {
  const h = harness(), save = h.deps.saveJob;
  h.deps.saveJob = async job => { if (job.files.length) throw new Error('checkpoint unavailable'); await save(job); };
  await assert.rejects(h.run(), /checkpoint unavailable/);
  assert.equal(h.calls.prepared.length, 1); assert.equal(h.calls.downloaded.length, 0);
  assert.ok(await h.files.get(`${h.months[0].month}.pdf`));
});

test('temporary disk write failure is fatal but already generated months remain resumable', async () => {
  const h = harness(), put = h.files.put;
  h.files.put = async (name, bytes) => { if (name.startsWith(h.months[1].month)) throw new Error('磁盘空间不足'); return put(name, bytes); };
  await assert.rejects(h.run(), /磁盘空间不足/); assert.equal(generatedExportMonths(h.job).size, 1);
  h.files.put = put; await h.run();
  assert.deepEqual(h.calls.prepared.slice(2), h.months.slice(1).map(item => item.month));
  assert.equal(h.calls.downloaded.length, 1);
});

test('failed ZIP write is discarded and complete month files survive for retry', async () => {
  const h = harness(), create = h.files.createWritable;
  h.files.createWritable = async name => { const writer = await create(name); return {...writer, async write() { throw new Error('zip disk full'); }}; };
  await assert.rejects(h.run(), /zip disk full/); assert.equal(h.calls.downloaded.length, 0);
  assert.equal(await h.files.get('archive.zip'), null); assert.equal(generatedExportMonths(h.job).size, 3);
  h.files.createWritable = create; await h.run(); assert.equal(h.calls.prepared.length, 3); assert.equal(h.calls.downloaded.length, 1);
});

test('completion checks reject missing revisions, attachment counts and invalid download IDs', () => {
  const months = batches(1), job = createExportJob(UID, options, months), month = {...job.plan[0], savedImageCount: 1, failedImageCount: 0};
  for (const receipt of [
    {state: 'in_progress', downloadId: 1, months: [month]}, {state: 'complete', downloadId: -1, months: [month]},
    {state: 'complete', downloadId: 1, months: [{...month, revision: 'old'}]},
    {state: 'complete', downloadId: 1, months: [{...month, failedImageCount: 1}]},
    {state: 'complete', downloadId: 1, months: [{...month, failedImageCount: undefined}]},
  ]) { job.downloads = [receipt]; assert.equal(completedExportMonths(job).size, 0); }
});
