import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isOriginalPost, mergePost, postKey} from '../extension/model.js';
import {savePostRecord} from '../extension/record-store.js';
import {selectMonthlyBatches} from '../extension/monthly.js';
import {createHistoryTask, runHistoryTask} from '../extension/history-runner.js';

const uid = '1000000001';
const original = {
  uid, id: 'Rtest12', text: '已保存的完整正文', images: [], emoticons: [],
  createdAt: '2026-01-15T00:00:00Z', fullText: true, isRepost: false,
  repostDetectionVersion: 2, repostText: '', repostUrl: '',
};
const source = readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const scanSource = source.slice(source.indexOf('async function scanOnce('), source.indexOf('async function start(){'));

function memoryStore(rows = []) {
  const records = new Map(rows.map(row => [postKey(row), structuredClone(row)]));
  return {
    records, fail: false,
    async get(store, key) { return store === 'posts' ? structuredClone(records.get(key)) : undefined; },
    async put(store, value) {
      if (store !== 'posts') return;
      if (this.fail) throw new Error('存储失败');
      records.set(postKey(value), structuredClone(value));
    },
    async remove(store, key) { records.delete(key); },
  };
}

async function scan(store, posts) {
  const context = vm.createContext({
    uid, connectionVersion:1, latestScan: null, db: store, isOriginalPost, postKey, savePostRecord,
    send: async () => ({ok: true, posts, diagnostics: {pageUid: uid}}),
    sleep: async () => {}, refresh: async () => {}, updateAccountAvatar:async () => {},
  });
  vm.runInContext(scanSource, context);
  return vm.runInContext('scanOnce()', context);
}

for (const fullText of [true, false]) {
  test(`page rescan excludes an existing original after a ${fullText ? 'complete' : 'partial'} repost observation`, async () => {
    const store = memoryStore([await mergePost(null, original)]);
    const repost = {...original, isRepost: true, repostText: '引用的原文', text: '后来的观察', fullText};
    const result = await scan(store, [repost, {...repost, id: 'Rnew123'}]);
    assert.equal(result.reposts, 2);
    assert.equal(store.records.size, 1, 'new reposts must remain excluded');
    const saved = store.records.get(postKey(original));
    assert.equal(isOriginalPost(saved), false);
    if (!fullText) assert.equal(saved.text, original.text, 'keep the complete body');
    assert.equal((await selectMonthlyBatches([...store.records.values()], {uid, originalOnly: true})).length, 0);

    await scan(store, [original]);
    assert.equal(isOriginalPost(store.records.get(postKey(original))), false, 'a collapsed card cannot erase repost evidence');
  });
}

test('excluded API repost corrects a trusted legacy decimal alias without inventing another record', async () => {
  const decimal = '90071992547409931234';
  const legacy = await mergePost(null, {...original, id: decimal});
  const store = memoryStore([legacy]);
  const saved = await savePostRecord(store, {...original, sourceId: decimal, isRepost: true}, {onlyExisting: true});
  assert.equal(store.records.size, 1);
  assert.equal(store.records.has(postKey(legacy)), false);
  assert.equal(isOriginalPost(saved), false);

  const unrelated = memoryStore([await mergePost(null, {...original, id: decimal, identitySource: 'mblogid'})]);
  assert.equal(await savePostRecord(unrelated, {...original, sourceId: decimal, isRepost: true}, {onlyExisting: true}), null);
  assert.equal(unrelated.records.size, 1, 'known numeric mblogids must not be treated as aliases');
});

test('failed correction preserves the existing record and legacy alias for retry', async () => {
  const decimal = '90071992547409931234';
  const legacy = await mergePost(null, {...original, id: decimal});
  const store = memoryStore([legacy]);
  store.fail = true;
  await assert.rejects(savePostRecord(store, {...original, sourceId: decimal, isRepost: true}, {onlyExisting: true}), /存储失败/);
  assert.deepEqual(store.records.get(postKey(legacy)), legacy);
});

test('history filtering awaits correction, retries a failed write on the same page, and skips longtext', async () => {
  const store = memoryStore([await mergePost(null, original)]);
  const repost = {...original, isRepost: true, fullText: false, needsLongText: [{kind: 'own', id: original.id}]};
  const calls = [];
  let paused = false;
  const deps = {
    request: async (kind, params) => {
      calls.push({kind, page: params.page});
      assert.equal(kind, 'search');
      return {ok: 1, data: {list: params.page === 1 ? [repost] : []}};
    },
    normalize: row => structuredClone(row), shouldIncludePost: isOriginalPost,
    saveExcludedPost: post => savePostRecord(store, post, {onlyExisting: true}),
    savePost: async () => assert.fail('excluded repost must not enter the normal save path'),
    saveTask: async () => {}, wait: async () => {}, shouldPause: () => paused,
  };
  const task = createHistoryTask(uid, '2026-01', '2026-01', Date.parse('2026-02-01T00:00:00Z'));
  store.fail = true;
  const failed = await runHistoryTask(task, deps);
  assert.equal(failed.status, 'paused');
  assert.equal(failed.months[0].page, 1);
  assert.equal(failed.months[0].pages.length, 0);

  store.fail = false;
  deps.saveExcludedPost = async post => {
    await savePostRecord(store, post, {onlyExisting: true});
    paused = true;
  };
  const interrupted = await runHistoryTask(failed, deps);
  assert.equal(interrupted.months[0].page, 1);
  assert.equal(isOriginalPost(store.records.get(postKey(original))), false);

  paused = false;
  deps.saveExcludedPost = post => savePostRecord(store, post, {onlyExisting: true});
  const resumed = await runHistoryTask(interrupted, deps);
  assert.equal(resumed.status, 'range-traversed-unverified');
  assert.equal(resumed.months[0].pages[0].skipped, 1);
  assert.equal(resumed.months[0].pages[0].saved, 0);
  assert.deepEqual(calls.map(call => call.page), [1, 1, 1, 2, 2]);
});
