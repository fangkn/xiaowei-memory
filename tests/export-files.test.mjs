import test from 'node:test';
import assert from 'node:assert/strict';
import {openExportFiles} from '../extension/export-files.js';

function memoryDirectory() {
  const files = new Map(), directories = new Map(), calls = {largestWrite: 0, aborted: 0, removed: []};
  const missing = () => Object.assign(new Error('not found'), {name: 'NotFoundError'});
  const directory = {
    async getDirectoryHandle(name, {create = false} = {}) {
      if (!directories.has(name)) { if (!create) throw missing(); directories.set(name, memoryDirectory()); }
      return directories.get(name).directory;
    },
    async getFileHandle(name, {create = false} = {}) {
      if (!files.has(name) && !create) throw missing();
      if (!files.has(name)) files.set(name, new Blob([]));
      return {async getFile() {return files.get(name);}, async createWritable() {
        const chunks = [];
        return {async write(bytes) {calls.largestWrite = Math.max(calls.largestWrite, bytes.length); chunks.push(bytes.slice());},
          async close() {files.set(name, new Blob(chunks));}, async abort() {calls.aborted++;}};
      }};
    },
    async removeEntry(name, options) {calls.removed.push({name, options}); if (!files.delete(name) && !directories.delete(name)) throw missing();},
  };
  return {directory, files, directories, calls};
}

test('OPFS month writes are chunked, durable after close, and cleanup only removes its own task directory', async () => {
  const root = memoryDirectory(), storage = {getDirectory: async () => root.directory}, job = {storageId: 'task-safe-123'};
  const files = await openExportFiles(job, {storage}), payload = new Uint8Array(3 * 1024 * 1024 + 7).fill(42);
  assert.equal(await files.get('missing.pdf'), null);
  assert.deepEqual(await files.put('2026-01.pdf', payload), {size: payload.length});
  assert.equal((await files.get('2026-01.pdf')).size, payload.length);
  const parent = root.directories.get('xiaowei-export-cache-v2'), task = parent.directories.get(job.storageId);
  assert.equal(task.calls.largestWrite, 1024 * 1024);
  const reopened = await openExportFiles(job, {storage}); assert.equal((await reopened.get('2026-01.pdf')).size, payload.length);
  await files.remove('missing.pdf'); await files.cleanup(); assert.equal(parent.directories.has(job.storageId), false);
  assert.deepEqual(parent.calls.removed, [{name: job.storageId, options: {recursive: true}}]);
});

test('OPFS rejects path traversal and provides explicit unsupported-browser and disk-quota errors', async () => {
  await assert.rejects(openExportFiles({storageId: '../unsafe'}), /目录无效/);
  await assert.rejects(openExportFiles({storageId: 'safe'}, {storage: {}}), /不支持本地临时文件/);
  await assert.rejects(openExportFiles({storageId: 'safe'}, {storage: {getDirectory: async () => {throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'});}}}), /临时存储空间不足/);
  const root = memoryDirectory(), files = await openExportFiles({storageId: 'safe'}, {storage: {getDirectory: async () => root.directory}});
  await assert.rejects(files.put('../a.pdf', new Uint8Array([1])), /文件名无效/);
  await assert.rejects(files.put('month.pdf', new Uint8Array()), /文件为空/);
});

test('failed OPFS writes abort their writer and keep the original failure visible', async () => {
  let aborted = false;
  const file = {createWritable: async () => ({write: async () => {throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'});}, close: async () => {}, abort: async () => {aborted = true;}})};
  const directory = {getDirectoryHandle: async () => directory, getFileHandle: async () => file};
  const files = await openExportFiles({storageId: 'safe'}, {storage: {getDirectory: async () => directory}});
  await assert.rejects(files.put('month.pdf', new Uint8Array([1])), /临时存储空间不足/); assert.equal(aborted, true);
});

test('blocked OPFS access explains recovery in Chinese and retains the browser error category', async () => {
  for (const name of ['SecurityError', 'NotAllowedError', 'InvalidStateError']) {
    await assert.rejects(openExportFiles({storageId: 'safe'}, {storage: {getDirectory: async () => {throw Object.assign(new Error('opaque browser failure'), {name});}}}),
      error => error.name === name && error.code === 'EXPORT_STORAGE_ACCESS' && /本地临时文件/.test(error.message) && /重新加载/.test(error.message));
  }
});
