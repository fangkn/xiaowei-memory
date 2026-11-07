import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportJob, exportJobKey, matchesExportJob, generatedExportMonths, completedExportMonths, runExportJob} from '../extension/export-runner.js';

const uid = '1000000001', options = {format: 'pdf-combined', images: true};
const batches = ['2026-10', '2026-11', 'unknown'].map((month, index) => ({
  uid, month, revision: `revision-${month}`, posts: [{uid, id: `Original${index}`}],
}));

function harness({job = createExportJob(uid, options, batches), entries = new Map(), fail = false, missing = false} = {}) {
  const calls = {prepared: [], downloads: [], blobs: [], snapshots: [], progress: [], revoked: []};
  const states = new Map();
  let invalid = false, nextId = Math.max(0, ...job.downloads.map(receipt => receipt.downloadId)) + 1;
  const files = {
    async get(name) { return entries.get(name) || null; },
    async put(name, bytes) { entries.set(name, new Blob([bytes])); return {size: bytes.byteLength}; },
    async remove(name) { entries.delete(name); },
    async createWritable() { assert.fail('combined PDF must not be packaged as ZIP'); },
  };
  const deps = {
    openFiles: async () => files,
    assertContext() { if (invalid) throw Object.assign(new Error('扩展已失效'), {code: 'EXTENSION_CONTEXT_INVALIDATED'}); },
    async prepareCombined(selected) {
      calls.prepared.push(structuredClone(selected));
      if (fail) throw new Error('合并 PDF 生成失败');
      return {bytes: new TextEncoder().encode('%PDF-1.7\nall selected months\n%%EOF'), extension: 'pdf', mime: 'application/pdf',
        pageCount: 3, savedImageCount: 2, failedImageCount: missing ? 1 : 0,
        attachmentFailures: missing ? [{postId: 'Original1', url: 'https://wx1.sinaimg.cn/large/missing.jpg', reason: '图片读取失败'}] : []};
    },
    async downloadFile(value) { const id = nextId++; calls.downloads.push({...value, id}); return id; },
    async downloadState(id) { return states.get(id) || 'complete'; },
    async saveJob(value) {
      const serialized = JSON.stringify(value);
      assert.doesNotMatch(serialized, /"(?:bytes|posts)":/, 'checkpoints contain metadata rather than private file bodies');
      calls.snapshots.push(JSON.parse(serialized));
    },
    createObjectURL(blob) { calls.blobs.push(blob); return `blob:test/${calls.blobs.length}`; },
    revokeObjectURL(url) { calls.revoked.push(url); },
    sleep: async () => {},
    onProgress: value => calls.progress.push(structuredClone(value)),
  };
  return {job, entries, files, calls, deps, states,
    run: () => runExportJob({job, batches, options}, deps),
    fix: () => { fail = false; missing = false; },
    fail: () => { fail = true; },
    invalidate: () => { invalid = true; },
  };
}

test('combined PDF jobs isolate their format and bind the entire selected month plan', () => {
  const job = createExportJob(uid, options, batches);
  assert.equal(exportJobKey(uid, options), `export-job:v2:pdf-combined:images:${uid}`);
  for (const format of ['pdf', 'markdown']) {
    assert.notEqual(exportJobKey(uid, options), exportJobKey(uid, {...options, format}));
    assert.equal(matchesExportJob(job, uid, {...options, format}, batches), false);
  }
  assert.equal(matchesExportJob(job, uid, options, batches), true);
  assert.equal(matchesExportJob(job, uid, options, batches.slice(1)), false);
  assert.equal(matchesExportJob(job, uid, options, batches.map((batch, index) => index ? batch : {...batch, revision: 'edited'})), false);
});

test('all selected months produce one PDF directly and one complete receipt for the whole selection', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.calls.prepared, [batches]);
  assert.deepEqual([...h.entries.keys()], ['combined.pdf']);
  assert.equal(h.calls.downloads.length, 1);
  assert.match(h.calls.downloads[0].filename, /-combined-originals-.*\.pdf$/);
  assert.equal(h.calls.downloads[0].saveAs, true);
  assert.equal(h.calls.blobs[0].type, 'application/pdf');
  assert.match(await h.calls.blobs[0].text(), /^%PDF-1.7/);
  assert.equal(h.job.files.length, 1);
  assert.equal(h.job.downloads[0].combined, true);
  assert.equal(generatedExportMonths(h.job).size, 3);
  assert.deepEqual([...completedExportMonths(h.job).keys()], batches.map(batch => batch.month));
  assert.equal(h.calls.progress.at(-1).phase, 'complete');
  assert.equal(h.calls.progress.at(-1).combined, true);
  assert.ok(h.calls.progress.every(progress => progress.phase !== 'packing'));
  assert.equal(h.calls.revoked.length, 1);
});

test('an unfinished download keeps every month unconfirmed and retains the PDF URL until completion', async () => {
  const h = harness();
  let finish, reached;
  const gate = new Promise(resolve => { finish = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  h.states.set(1, 'in_progress');
  h.deps.sleep = async () => { reached(); await gate; };
  const run = h.run();
  await waiting;
  assert.equal(completedExportMonths(h.job).size, 0);
  assert.equal(h.calls.revoked.length, 0);
  h.states.set(1, 'complete'); finish(); await run;
  assert.equal(completedExportMonths(h.job).size, 3);
  assert.equal(h.calls.revoked.length, 1);
});

test('cancelled combined download survives reload and retries the stored PDF without rendering again', async () => {
  const h = harness(); h.states.set(1, 'interrupted');
  await assert.rejects(h.run(), error => error.code === 'EXPORT_DOWNLOAD_INTERRUPTED' && /合并 PDF/.test(error.message));
  assert.equal(completedExportMonths(h.job).size, 0);
  assert.equal(generatedExportMonths(h.job).size, 3);
  const resumed = harness({job: structuredClone(h.job), entries: h.entries});
  resumed.states.set(1, 'interrupted');
  await resumed.run();
  assert.equal(resumed.calls.prepared.length, 0);
  assert.equal(resumed.calls.downloads.length, 1);
  assert.equal(completedExportMonths(resumed.job).size, 3);
  assert.equal(resumed.calls.progress.at(-1).reused, 3);
});

test('missing or truncated combined temporary file regenerates the entire selection', async () => {
  for (const corrupt of [null, new Blob(['bad'])]) {
    const h = harness(); h.states.set(1, 'interrupted');
    await assert.rejects(h.run());
    if (corrupt) h.entries.set('combined.pdf', corrupt); else h.entries.delete('combined.pdf');
    await h.run();
    assert.deepEqual(h.calls.prepared, [batches, batches]);
    assert.equal(completedExportMonths(h.job).size, 3);
  }
});

test('one missing attachment prevents confirming any month and retry replaces the complete combined file', async () => {
  const h = harness({missing: true});
  await h.run();
  assert.equal(h.calls.downloads.length, 1, 'the incomplete PDF remains available for inspection');
  assert.equal(completedExportMonths(h.job).size, 0);
  assert.equal(generatedExportMonths(h.job).size, 3);
  assert.equal(h.calls.progress.at(-1).ready, 0);
  assert.equal(h.calls.progress.at(-1).phase, 'partial');
  assert.equal(h.job.failures.find(failure => failure.month === '2026-11').attachments.length, 1);
  assert.equal(h.job.failures.find(failure => failure.month === '2026-10').attachments.length, 0);
  h.fix(); await h.run();
  assert.deepEqual(h.calls.prepared, [batches, batches]);
  assert.equal(h.calls.downloads.length, 2);
  assert.equal(completedExportMonths(h.job).size, 3);
  assert.deepEqual(h.job.failures, []);
});

test('render failure never downloads an incomplete file and cannot reuse an old failed PDF', async () => {
  const h = harness({missing: true}); await h.run();
  h.fail(); await h.run();
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(generatedExportMonths(h.job).size, 0);
  assert.equal(completedExportMonths(h.job).size, 0);
  assert.equal(h.job.failures.length, 3);
  h.fix(); await h.run();
  assert.equal(h.calls.downloads.length, 2);
  assert.equal(completedExportMonths(h.job).size, 3);
});

test('context loss, failed disk writes, and failed checkpoint writes cannot start a combined download', async () => {
  const invalid = harness(), prepare = invalid.deps.prepareCombined;
  invalid.deps.prepareCombined = async selected => { const result = await prepare(selected); invalid.invalidate(); return result; };
  await assert.rejects(invalid.run(), error => error.code === 'EXTENSION_CONTEXT_INVALIDATED');
  assert.equal(invalid.calls.downloads.length, 0);
  assert.equal(generatedExportMonths(invalid.job).size, 0);
  const disk = harness(); disk.files.put = async () => { throw new Error('磁盘空间不足'); };
  await assert.rejects(disk.run(), /磁盘空间不足/);
  assert.equal(disk.calls.downloads.length, 0);
  assert.equal(generatedExportMonths(disk.job).size, 0);
  const checkpoint = harness(), save = checkpoint.deps.saveJob;
  checkpoint.deps.saveJob = async job => { if (job.files.length) throw new Error('检查点写入失败'); await save(job); };
  await assert.rejects(checkpoint.run(), /检查点写入失败/);
  assert.equal(checkpoint.calls.downloads.length, 0);
  assert.ok(checkpoint.entries.has('combined.pdf'));
});

test('completion requires one exact complete receipt, never a union of partial or failed receipts', () => {
  const job = createExportJob(uid, options, batches);
  const months = job.plan.map(month => ({...month, failedImageCount: 0, savedImageCount: 0}));
  const receipt = {combined: true, state: 'complete', downloadId: 1, months};
  const cases = [
    [{...receipt, combined: undefined}],
    [{...receipt, months: months.slice(1)}],
    months.map(month => ({...receipt, months: [month]})),
    [{...receipt, months: months.map((month, index) => index ? month : {...month, failedImageCount: 1})}],
    [{...receipt, months: months.map((month, index) => index ? month : {...month, revision: 'old'})}],
    [{...receipt, months: [months[0], months[0], months[2]]}],
    [{...receipt, months: [...months].reverse()}],
  ];
  for (const downloads of cases) { job.downloads = downloads; assert.equal(completedExportMonths(job).size, 0); }
  job.downloads = [receipt]; assert.equal(completedExportMonths(job).size, 3);
});

test('completed download needs no temporary files and unknown download state remains unconfirmed', async () => {
  const complete = harness(); await complete.run();
  complete.deps.openFiles = async () => { assert.fail('completed download does not need temporary files'); };
  await complete.run();
  assert.equal(complete.calls.prepared.length, 1);
  assert.equal(complete.calls.downloads.length, 1);
  const unknown = harness(); unknown.states.set(1, 'unknown');
  await assert.rejects(unknown.run(), error => error.code === 'EXPORT_DOWNLOAD_UNKNOWN');
  assert.equal(completedExportMonths(unknown.job).size, 0);
  assert.equal(unknown.calls.revoked.length, 1);
});
