import test from 'node:test';
import assert from 'node:assert/strict';
import {buildZip, crc32} from '../extension/archive.js';
import {readStoredZipEntries} from '../extension/zip-reader.js';
import {writeStreamingZip} from '../extension/zip-stream.js';

const encoder = new TextEncoder();
function fixture(entries = [{name: 'month.md', data: 'cached month'}]) { return buildZip(entries); }
function layout(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  const central = view.getUint32(end + 16, true), nameLength = view.getUint16(central + 28, true);
  return {view, end, central, nameLength, payload: 30 + nameLength};
}
function collectedSink() {
  const chunks = [];
  return {chunks, async write(bytes) {chunks.push(bytes.slice());}};
}
function mutatedName(nameBytes) {
  const bytes = fixture([{name: 'x'.repeat(nameBytes.length), data: 'text'}]), {central} = layout(bytes);
  bytes.set(nameBytes, 30); bytes.set(nameBytes, central + 46);
  return bytes;
}

test('reads buildZip UTF-8 notes, binary images and empty members without changing bytes', async () => {
  const original = [
    {name: '微博备份/2026/2026-11.md', data: encoder.encode('# 测试 🎉\n![图片](../assets/01.png)')},
    {name: '微博备份/assets/01.png', data: new Uint8Array([137, 80, 78, 71, 0, 255, 26, 10])},
    {name: '\ufeff空文件.md', data: new Uint8Array()},
  ];
  const members = await readStoredZipEntries(new Blob([fixture(original)]));
  assert.equal(members.length, original.length);
  for (const [index, member] of members.entries()) {
    assert.equal(member.name, original[index].name);
    assert.equal(member.size, original[index].data.length);
    assert.equal(member.crc32, crc32(original[index].data));
    assert.deepEqual(new Uint8Array(await (await member.open()).arrayBuffer()), original[index].data);
  }
  assert.deepEqual(await readStoredZipEntries(new Blob([buildZip([])])), []);
});

test('directory parsing only reads short headers and names; final output streams payload slices', async () => {
  const data = new Uint8Array(3 * 1024 * 1024 + 9); data[0] = 137; data[data.length - 1] = 255;
  const bytes = fixture([{name: '月份/assets/图片.png', data}]), blob = new Blob([bytes]);
  const {payload, central} = layout(bytes), reads = [], slices = [];
  const source = {
    size: blob.size,
    arrayBuffer() {throw new Error('must not read whole archive');},
    slice(start, end) {
      slices.push([start, end]);
      const part = blob.slice(start, end);
      return {size: part.size, stream: () => part.stream(), arrayBuffer: async () => {
        assert.ok(end <= payload || start >= central, 'must not read member payload into an ArrayBuffer');
        assert.ok(end - start <= 65535); reads.push([start, end]);
        return part.arrayBuffer();
      }};
    },
  };
  const members = await readStoredZipEntries(source);
  assert.equal(reads.length, 5);
  assert.ok(!slices.some(([start, end]) => start === payload && end === central));
  const output = collectedSink();
  await writeStreamingZip(members, output);
  assert.equal(reads.length, 5);
  assert.deepEqual(slices.at(-1), [payload, central]);
  assert.ok(output.chunks.every(chunk => chunk.length <= 1024 * 1024));
});

test('rejects invalid ZIP32 file sizes before asking for any slice', async () => {
  for (const size of [-1, 0, 21, 22.5, NaN, Infinity, 0xffffffff, 0x100000000]) {
    await assert.rejects(readStoredZipEntries({size, slice() {throw new Error('must not read');}}), /大小或类型/);
  }
  await assert.rejects(readStoredZipEntries(null), /大小或类型/);
  await assert.rejects(readStoredZipEntries({size: 22}), /大小或类型/);
});

test('rejects inconsistent end records, split disks, unsupported metadata and ZIP64 markers', async () => {
  const cases = [
    ['end signature', 'end', 0, 4, 0], ['end disk', 'end', 4, 2, 1], ['directory disk', 'end', 6, 2, 1],
    ['disk entry count', 'end', 8, 2, 0], ['total count too low', 'end', 10, 2, 0], ['total count too high', 'end', 10, 2, 2],
    ['end comment', 'end', 20, 2, 1], ['ZIP64 directory size', 'end', 12, 4, 0xffffffff], ['ZIP64 directory offset', 'end', 16, 4, 0xffffffff],
    ['central signature', 'central', 0, 4, 0], ['central version made', 'central', 4, 2, 45], ['central version required', 'central', 6, 2, 45],
    ['data descriptor', 'central', 8, 2, 0x0808], ['encryption', 'central', 8, 2, 0x0801], ['non UTF-8', 'central', 8, 2, 0],
    ['compression', 'central', 10, 2, 8], ['central time', 'central', 12, 2, 1], ['central date', 'central', 14, 2, 0],
    ['compressed size', 'central', 20, 4, 1], ['ZIP64 size', 'central', 24, 4, 0xffffffff], ['empty name', 'central', 28, 2, 0],
    ['extra field', 'central', 30, 2, 1], ['file comment', 'central', 32, 2, 1], ['member disk', 'central', 34, 2, 1],
    ['internal attributes', 'central', 36, 2, 1], ['external attributes', 'central', 38, 4, 0xa1ff0000], ['local offset', 'central', 42, 4, 1],
    ['ZIP64 local offset', 'central', 42, 4, 0xffffffff],
  ];
  for (const [label, base, field, width, value] of cases) {
    const bytes = fixture(), positions = layout(bytes);
    positions.view[width === 2 ? 'setUint16' : 'setUint32'](positions[base] + field, value, true);
    await assert.rejects(readStoredZipEntries(new Blob([bytes])), /ZIP 无效/, label);
  }
});

test('rejects local fields and filename bytes that disagree with the central directory', async () => {
  const cases = [
    [0, 4, 0], [4, 2, 45], [6, 2, 0x0808], [8, 2, 8], [10, 2, 1], [12, 2, 0],
    [14, 4, 1], [18, 4, 1], [22, 4, 1], [26, 2, 1], [28, 2, 1],
  ];
  for (const [offset, width, value] of cases) {
    const bytes = fixture(), {view} = layout(bytes);
    view[width === 2 ? 'setUint16' : 'setUint32'](offset, value, true);
    await assert.rejects(readStoredZipEntries(new Blob([bytes])), /本地文件头与中央目录不匹配/);
  }
  const bytes = fixture(); bytes[30] ^= 1;
  await assert.rejects(readStoredZipEntries(new Blob([bytes])), /本地文件名与中央目录不匹配/);
});

test('rejects unsafe paths, malformed UTF-8 and duplicate members', async () => {
  for (const name of ['../a.md', '/a.md', 'C:a.md', 'a\\b.md', 'a//b.md', 'a/./b.md', 'a/../b.md', 'a/\0.md', 'a/']) {
    await assert.rejects(readStoredZipEntries(new Blob([mutatedName(encoder.encode(name))])), /不安全的文件路径/, name);
  }
  await assert.rejects(readStoredZipEntries(new Blob([mutatedName(new Uint8Array([0xc0, 0xaf]))])), /UTF-8/);
  const bytes = fixture([{name: 'a.md', data: 'a'}, {name: 'b.md', data: 'b'}]), {central, nameLength} = layout(bytes);
  const secondCentral = central + 46 + nameLength, view = new DataView(bytes.buffer), secondLocal = view.getUint32(secondCentral + 42, true);
  bytes[secondCentral + 46] = bytes[central + 46]; bytes[secondLocal + 30] = bytes[30];
  await assert.rejects(readStoredZipEntries(new Blob([bytes])), /重复的文件路径/);
});

test('rejects member overlap, directories with wrong bounds, missing members and truncation', async () => {
  const original = fixture([{name: 'a.md', data: 'first'}, {name: 'b.md', data: 'second'}]);
  for (const change of [
    ({view, central}) => view.setUint32(central + 46 + 4 + 42, 0, true),
    ({view, central}) => {view.setUint32(18, 1000, true); view.setUint32(22, 1000, true); view.setUint32(central + 20, 1000, true); view.setUint32(central + 24, 1000, true);},
    ({view, end}) => view.setUint32(end + 12, view.getUint32(end + 12, true) - 1, true),
    ({view, end}) => view.setUint32(end + 16, view.getUint32(end + 16, true) + 1, true),
    ({view, end}) => {view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true);},
  ]) {
    const bytes = original.slice(); change(layout(bytes));
    await assert.rejects(readStoredZipEntries(new Blob([bytes])), /ZIP 无效/);
  }
  for (const bytes of [original.slice(1), original.slice(0, -1), original.slice(0, 22), new Uint8Array([...original, 0]), new Uint8Array([0, ...original])]) {
    await assert.rejects(readStoredZipEntries(new Blob([bytes])), /ZIP 无效/);
  }
  const blob = new Blob([original]);
  await assert.rejects(readStoredZipEntries({size: blob.size, slice(start, end) {return blob.slice(start, end - 1);}}), /截断/);
  await assert.rejects(readStoredZipEntries({size: blob.size, slice(start, end) {return {size: end - start, arrayBuffer: async () => new ArrayBuffer(end - start - 1)};}}), /截断/);
});

test('corrupt cached bytes are rejected by final CRC verification before producing a finished ZIP', async () => {
  const bytes = fixture(), {payload} = layout(bytes); bytes[payload] ^= 0xff;
  const members = await readStoredZipEntries(new Blob([bytes])), output = collectedSink();
  let aborted = false;
  try { await writeStreamingZip(members, output); assert.fail('corrupt payload must fail'); }
  catch (error) {
    assert.equal(error.code, 'ZIP_SOURCE_CRC_MISMATCH'); assert.equal(error.entryName, members[0].name);
    aborted = true;
  }
  assert.equal(aborted, true);
  assert.equal(output.chunks.reduce((sum, chunk) => sum + chunk.length, 0), 30 + encoder.encode(members[0].name).length + members[0].size);
});

test('context cancellation is checked before and after metadata reads and before opening members', async () => {
  const blob = new Blob([fixture()]); let cancelled = true, reads = 0, slices = 0;
  const source = {size: blob.size, slice(start, end) {
    slices++; const part = blob.slice(start, end);
    return {size: part.size, stream: () => part.stream(), arrayBuffer: async () => {reads++; cancelled = true; return part.arrayBuffer();}};
  }};
  const assertContext = () => {if (cancelled) throw new Error('cancelled');};
  await assert.rejects(readStoredZipEntries(source, {assertContext}), /cancelled/);
  assert.equal(slices, 0);
  cancelled = false;
  await assert.rejects(readStoredZipEntries(source, {assertContext}), /cancelled/);
  assert.equal(reads, 1); assert.equal(slices, 1);
  cancelled = false;
  const members = await readStoredZipEntries(blob, {assertContext}); cancelled = true;
  await assert.rejects(members[0].open(), /cancelled/);
});
