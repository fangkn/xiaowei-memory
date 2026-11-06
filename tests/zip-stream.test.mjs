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
