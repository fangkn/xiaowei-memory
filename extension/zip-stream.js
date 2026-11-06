const encoder = new TextEncoder();
const MAX_ZIP_BYTES = 0xffffffff;
const MAX_CHUNK_BYTES = 1024 * 1024;
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[n] = crc >>> 0;
}
function updateCrc(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function header(length) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  return {bytes, u16: (offset, value) => view.setUint16(offset, value, true), u32: (offset, value) => view.setUint32(offset, value, true)};
}
function safeName(value) {
  if (typeof value !== 'string' || /[\\\0]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('不安全的 ZIP 文件路径。');
  const bytes = encoder.encode(value);
  if (bytes.length > 65535) throw new Error('ZIP 文件名过长。');
  return bytes;
}

/** 按小块写入 ZIP STORE；只保留中央目录元数据，不汇聚全部 PDF 字节。 */
export async function writeStreamingZip(entries, sink, {assertContext = () => {}, onProgress = () => {}} = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 65535) throw new Error('ZIP 文件数量无效。');
  if (typeof sink?.write !== 'function') throw new Error('无法写入本地 ZIP 临时文件。');
  const seen = new Set();
  let expectedSize = 22, totalBytes = 0;
  const prepared = entries.map(entry => {
    const name = safeName(entry.name);
    if (seen.has(entry.name)) throw new Error('ZIP 内有重复文件路径。');
    seen.add(entry.name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.open !== 'function') throw new Error('ZIP 文件数据无效。');
    expectedSize += 30 + name.length + entry.size + 16 + 46 + name.length;
    totalBytes += entry.size;
    // ZIP32 保留 0xffffffff 作为 ZIP64 标记，避免写出部分可读的超大文件。
    if (entry.size >= MAX_ZIP_BYTES || expectedSize >= MAX_ZIP_BYTES) throw new Error('整包超过 ZIP32 的 4 GiB 容量，请缩小所选月份范围。');
    return {...entry, encodedName: name};
  });
  let offset = 0, packedBytes = 0, lastProgressBytes = 0;
  const directory = [];
  const write = async bytes => {
    for (let start = 0; start < bytes.length; start += MAX_CHUNK_BYTES) {
      assertContext();
      const chunk = bytes.subarray(start, start + MAX_CHUNK_BYTES);
      await sink.write(chunk);
      offset += chunk.length;
    }
  };
  onProgress({packedBytes, totalBytes});
  for (const entry of prepared) {
    assertContext();
    const localOffset = offset, local = header(30), name = entry.encodedName;
    local.u32(0, 0x04034b50); local.u16(4, 20); local.u16(6, 0x0808); local.u16(8, 0);
    local.u16(12, 0x0021); local.u16(26, name.length);
    await write(local.bytes); await write(name);
    const file = await entry.open();
    if (!file || file.size !== entry.size || typeof file.stream !== 'function') throw new Error(`临时文件已变化：${entry.name}。请重试导出。`);
    const reader = file.stream().getReader();
    let size = 0, crc = 0xffffffff;
    try {
      while (true) {
        assertContext();
        const {done, value} = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || size + value.byteLength > entry.size) throw new Error(`临时文件大小不匹配：${entry.name}。`);
        size += value.byteLength; crc = updateCrc(crc, value);
        await write(value);
        packedBytes += value.byteLength;
        if (packedBytes - lastProgressBytes >= MAX_CHUNK_BYTES || packedBytes === totalBytes) {
          onProgress({packedBytes, totalBytes}); lastProgressBytes = packedBytes;
        }
      }
    } catch (error) { try { await reader.cancel(); } catch { /* 失败清理由调用方处理。 */ } throw error; }
    finally { reader.releaseLock(); }
    if (size !== entry.size) throw new Error(`临时文件读取不完整：${entry.name}。`);
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = header(16);
    descriptor.u32(0, 0x08074b50); descriptor.u32(4, crc); descriptor.u32(8, size); descriptor.u32(12, size);
    await write(descriptor.bytes);
    const central = header(46);
    central.u32(0, 0x02014b50); central.u16(4, 20); central.u16(6, 20); central.u16(8, 0x0808);
    central.u16(14, 0x0021); central.u32(16, crc); central.u32(20, size); central.u32(24, size);
    central.u16(28, name.length); central.u32(42, localOffset);
    directory.push({bytes: central.bytes, name});
  }
  const directoryOffset = offset;
  for (const entry of directory) { await write(entry.bytes); await write(entry.name); }
  const end = header(22);
  end.u32(0, 0x06054b50); end.u16(8, directory.length); end.u16(10, directory.length);
  end.u32(12, offset - directoryOffset); end.u32(16, directoryOffset);
  await write(end.bytes);
  if (offset !== expectedSize) throw new Error('ZIP 文件大小校验失败。');
  return {size: offset, entries: directory.length};
}
