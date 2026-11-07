import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from '../extension/archive.js';
import {writeStreamingZip} from '../extension/zip-stream.js';

function sink() {
  const chunks = [];
  return {chunks, async write(bytes) { chunks.push(bytes.slice()); }, result() {
    const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  }};
}
function entry(name, data) { const blob = new Blob([data]); return {name, size: blob.size, open: async () => blob}; }
function unreadableEntry(stage, error, cleanup = {}) {
  const reader = {
    async read() {if (stage === 'read') throw error; return {done: true};},
    async cancel() {cleanup.cancelled = true;},
    releaseLock() {cleanup.released = true;},
  };
  const file = {size: 0, stream() {
    if (stage === 'stream') throw error;
    return {getReader() {if (stage === 'getReader') throw error; return reader;}};
  }};
  return {name: '2026-11/month.md', size: 0, async open() {if (stage === 'open') throw error; return file;}};
}

test('UTF-8 filenames, ZIP descriptors and empty entries are valid and CRCs match', async () => {
  const output = sink(), entries = [entry('月度备份/2026-01.pdf', '中文内容 🎉'), entry('empty.txt', '')];
  const result = await writeStreamingZip(entries, output), bytes = output.result(), view = new DataView(bytes.buffer);
  assert.equal(result.size, bytes.length); assert.equal(result.entries, 2);
  const end = bytes.length - 22; assert.equal(view.getUint32(end, true), 0x06054b50);
  let central = view.getUint32(end + 16, true);
  for (const expected of entries) {
    assert.equal(view.getUint32(central, true), 0x02014b50); assert.equal(view.getUint16(central + 8, true), 0x808);
    const nameLength = view.getUint16(central + 28, true), name = new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + nameLength));
    assert.equal(name, expected.name);
    const local = view.getUint32(central + 42, true), start = local + 30 + nameLength, size = view.getUint32(central + 24, true);
    assert.equal(view.getUint32(local, true), 0x04034b50); assert.equal(size, expected.size);
    const actual = bytes.subarray(start, start + size), crc = crc32(actual);
    assert.equal(view.getUint32(central + 16, true), crc); assert.equal(view.getUint32(start + size, true), 0x08074b50);
    assert.equal(view.getUint32(start + size + 4, true), crc); central += 46 + nameLength;
  }
  assert.equal(central, end);
});

test('large source chunks are split before the disk writer, and source arrayBuffer is never requested', async () => {
  let max = 0, written = 0, progress;
  const size = 3 * 1024 * 1024 + 5, source = {
    size, arrayBuffer() { throw new Error('must stream'); },
    stream() { return new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(size)); controller.close(); }}); },
  };
  const result = await writeStreamingZip([{name: 'large.pdf', size, open: async () => source}], {
    async write(chunk) { max = Math.max(max, chunk.length); written += chunk.length; },
  }, {onProgress: value => {progress = value;}});
  assert.ok(max <= 1024 * 1024); assert.equal(result.size, written);
  assert.deepEqual(progress, {packedBytes: size, totalBytes: size});
});

test('unsafe names, duplicate names and oversized ZIP32 totals fail before opening source files', async () => {
  for (const entries of [
    [entry('../escape.pdf', 'a')], [entry('/escape.pdf', 'a')], [entry('C:escape.pdf', 'a')],
    [entry('a\\b.pdf', 'a')], [entry('a//b.pdf', 'a')], [entry('a.pdf', 'a'), entry('a.pdf', 'b')],
    [{name: 'large.pdf', size: 0xffffffff - 10, open: () => { throw new Error('must not open'); }}],
  ]) {
    const output = sink(); await assert.rejects(writeStreamingZip(entries, output), /路径|重复|4 GiB/); assert.equal(output.chunks.length, 0);
  }
});

test('source changed, shortened or longer than its checkpoint cannot produce a completed ZIP', async () => {
  const mismatched = [{name: 'month.pdf', size: 3, open: async () => new Blob(['ab'])}];
  await assert.rejects(writeStreamingZip(mismatched, sink()), /已变化/);
  for (const bytes of [new Uint8Array(2), new Uint8Array(4)]) {
    const source = {size: 3, stream: () => new ReadableStream({start(controller) {controller.enqueue(bytes); controller.close();}})};
    await assert.rejects(writeStreamingZip([{name: 'month.pdf', size: 3, open: async () => source}], sink()), /不匹配|不完整/);
  }
});

test('context cancellation aborts the source reader instead of continuing to write', async () => {
  let checks = 0, cancelled = false;
  const source = {size: 100, stream: () => new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(10));}, cancel() {cancelled = true;}})};
  await assert.rejects(writeStreamingZip([{name: 'month.pdf', size: 100, open: async () => source}], sink(), {
    assertContext() { if (++checks > 7) throw new Error('stale context'); },
  }), /stale context/);
  assert.equal(cancelled, true);
});

test('optional expected CRC32 is checked for notes, images and empty files', async () => {
  const entries = [entry('中文.md', '中文正文'), entry('image.png', new Uint8Array([137, 80, 78, 71, 0, 255])), entry('empty.md', '')];
  for (const item of entries) item.crc32 = crc32(new Uint8Array(await (await item.open()).arrayBuffer()));
  const output = sink();
  assert.equal((await writeStreamingZip(entries, output)).entries, 3);
  const changed = {...entries[0], crc32: entries[0].crc32 ^ 1};
  changed.crc32 >>>= 0;
  const incomplete = sink();
  await assert.rejects(writeStreamingZip([changed], incomplete), error => {
    assert.equal(error.code, 'ZIP_SOURCE_CRC_MISMATCH'); assert.equal(error.entryName, changed.name);
    return /CRC32 校验失败/.test(error.message);
  });
  assert.equal(incomplete.result().length, 30 + new TextEncoder().encode(changed.name).length + changed.size);
});

test('invalid expected CRC32 values fail preflight before opening or writing any member', async () => {
  for (const expected of [-1, 0x100000000, 0.5, NaN, Infinity, '0', null, 1n]) {
    let opened = false;
    const output = sink(), item = {name: 'month.md', size: 0, crc32: expected, open() {opened = true; throw new Error('must not open');}};
    await assert.rejects(writeStreamingZip([entry('first.md', 'valid'), item], output), /CRC32 无效/);
    assert.equal(opened, false); assert.equal(output.chunks.length, 0);
  }
  // 无符号 32 位边界是合法的预期值；错误内容应在读取后作为 CRC 不匹配报告。
  for (const expected of [0, 0xffffffff]) {
    const item = {...entry('month.md', 'payload'), crc32: expected};
    await assert.rejects(writeStreamingZip([item], sink()), error => error.code === 'ZIP_SOURCE_CRC_MISMATCH');
  }
});

for (const stage of ['open', 'stream', 'getReader', 'read']) {
  test(`unreadable source ${stage} failures identify the cached member and preserve their cause`, async () => {
    const cause = new DOMException('The source file cannot be read.', 'NotReadableError'), cleanup = {};
    const item = unreadableEntry(stage, cause, cleanup);
    await assert.rejects(writeStreamingZip([item], sink()), error => {
      assert.equal(error.code, 'ZIP_SOURCE_CHANGED'); assert.equal(error.entryName, item.name);
      assert.equal(error.cause, cause); assert.match(error.message, /临时源不可读/);
      return true;
    });
    if (stage === 'read') assert.deepEqual(cleanup, {cancelled: true, released: true});
  });
}

test('source cancellation and extension invalidation errors retain their original identity', async () => {
  const errors = [
    Object.assign(new Error('扩展已失效'), {code: 'EXTENSION_CONTEXT_INVALIDATED'}),
    new DOMException('The operation was aborted.', 'AbortError'),
    Object.assign(new Error('cancelled'), {code: 'ABORT_ERR'}),
    new Error('Extension context invalidated.'),
  ];
  for (const stage of ['open', 'stream', 'getReader', 'read']) for (const original of errors) {
    await assert.rejects(writeStreamingZip([unreadableEntry(stage, original)], sink()), error => error === original);
    assert.equal(original.entryName, undefined);
  }
});

test('writer context failures retain their original identity before and during source reads', async () => {
  for (const limit of [1, 4, 5, 6]) {
    let checks = 0;
    const original = new Error('stale context');
    await assert.rejects(writeStreamingZip([entry('month.md', 'data')], sink(), {
      assertContext() {if (++checks >= limit) throw original;},
    }), error => error === original);
    assert.equal(original.code, undefined); assert.equal(original.entryName, undefined);
  }
});

test('target write failures including quota errors are not attributed to the source member', async () => {
  for (const failAt of [1, 3]) for (const name of ['QuotaExceededError', 'NotReadableError']) {
    const original = new DOMException('Cannot write target archive.', name); let writes = 0, cancelled = false;
    const source = {size: 10, stream: () => new ReadableStream({
      pull(controller) {controller.enqueue(new Uint8Array(10));},
      cancel() {cancelled = true;},
    })};
    await assert.rejects(writeStreamingZip([{name: 'month.md', size: source.size, open: async () => source}], {
      async write() {if (++writes === failAt) throw original;},
    }), error => error === original);
    assert.equal(original.entryName, undefined);
    assert.notEqual(original.code, 'ZIP_SOURCE_CHANGED');
    assert.equal(cancelled, failAt === 3);
  }
});
