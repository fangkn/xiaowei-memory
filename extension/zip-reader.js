const MAX_ZIP_BYTES = 0xffffffff;
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function invalid(detail) { return new Error(`月份缓存 ZIP 无效：${detail}。请重新生成该月缓存。`); }
function safeName(bytes) {
  let name;
  try { name = decoder.decode(bytes); } catch { throw invalid('文件名不是有效 UTF-8'); }
  if (!name || /[\\\0]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('不安全的文件路径');
  return name;
}

/** 只读取 buildZip 生成的固定 ZIP32 STORE 目录；文件内容保留为磁盘 Blob 切片。 */
export async function readStoredZipEntries(blob, {assertContext = () => {}} = {}) {
  assertContext();
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 22 || blob.size >= MAX_ZIP_BYTES || typeof blob.slice !== 'function') throw invalid('文件大小或类型不受支持');
  const archiveSize = blob.size;
  const read = async (start, length) => {
    assertContext();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > archiveSize) throw invalid('读取范围越界');
    const slice = blob.slice(start, start + length);
    if (!slice || slice.size !== length || typeof slice.arrayBuffer !== 'function') throw invalid('文件被截断');
    const bytes = new Uint8Array(await slice.arrayBuffer());
    assertContext();
    if (bytes.length !== length) throw invalid('文件被截断');
    return bytes;
  };
  const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // buildZip 不输出注释，因此尾目录必须恰好占最后 22 字节，无需扫描或读取整包。
  const endOffset = archiveSize - 22, end = viewOf(await read(endOffset, 22));
  if (end.getUint32(0, true) !== 0x06054b50 || end.getUint16(4, true) !== 0 || end.getUint16(6, true) !== 0 || end.getUint16(20, true) !== 0) throw invalid('尾目录格式或磁盘号不受支持');
  const count = end.getUint16(10, true), directorySize = end.getUint32(12, true), directoryOffset = end.getUint32(16, true);
  if (end.getUint16(8, true) !== count || directorySize === MAX_ZIP_BYTES || directoryOffset === MAX_ZIP_BYTES || directoryOffset + directorySize !== endOffset || count * 47 > directorySize) throw invalid('中央目录数量或范围不匹配');
  const entries = [], names = new Set();
  let directoryCursor = directoryOffset, localCursor = 0;
  for (let index = 0; index < count; index++) {
    assertContext();
    if (directoryCursor + 46 > endOffset) throw invalid('中央目录被截断');
    const central = viewOf(await read(directoryCursor, 46));
    if (central.getUint32(0, true) !== 0x02014b50 || central.getUint16(4, true) !== 20 || central.getUint16(6, true) !== 20 || central.getUint16(8, true) !== 0x0800 || central.getUint16(10, true) !== 0 || central.getUint16(12, true) !== 0 || central.getUint16(14, true) !== 33) throw invalid('中央目录必须为未加密的 UTF-8 ZIP32 STORE 格式');
    const crc32 = central.getUint32(16, true), size = central.getUint32(24, true), nameLength = central.getUint16(28, true), localOffset = central.getUint32(42, true);
    if (size === MAX_ZIP_BYTES || central.getUint32(20, true) !== size || !nameLength || central.getUint16(30, true) !== 0 || central.getUint16(32, true) !== 0 || central.getUint16(34, true) !== 0 || central.getUint16(36, true) !== 0 || central.getUint32(38, true) !== 0) throw invalid('中央目录包含不支持的大小、扩展或属性');
    if (directoryCursor + 46 + nameLength > endOffset || localOffset !== localCursor || localOffset + 30 + nameLength + size > directoryOffset) throw invalid('成员范围重叠、越界或偏移不匹配');
    const encodedName = await read(directoryCursor + 46, nameLength), name = safeName(encodedName);
    if (names.has(name)) throw invalid('重复的文件路径');
    names.add(name);
    const local = viewOf(await read(localOffset, 30));
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(4, true) !== 20 || local.getUint16(6, true) !== 0x0800 || local.getUint16(8, true) !== 0 || local.getUint16(10, true) !== 0 || local.getUint16(12, true) !== 33 || local.getUint32(14, true) !== crc32 || local.getUint32(18, true) !== size || local.getUint32(22, true) !== size || local.getUint16(26, true) !== nameLength || local.getUint16(28, true) !== 0) throw invalid('本地文件头与中央目录不匹配');
    const localName = await read(localOffset + 30, nameLength);
    if (localName.some((byte, position) => byte !== encodedName[position])) throw invalid('本地文件名与中央目录不匹配');
    const payloadStart = localOffset + 30 + nameLength, payloadEnd = payloadStart + size;
    entries.push({name, size, crc32, open: async () => {
      assertContext();
      const file = blob.slice(payloadStart, payloadEnd);
      if (!file || file.size !== size || typeof file.stream !== 'function') throw invalid('成员文件被截断');
      return file;
    }});
    localCursor = payloadEnd;
    directoryCursor += 46 + nameLength;
  }
  if (directoryCursor !== endOffset || localCursor !== directoryOffset) throw invalid('目录数量、大小或成员范围不匹配');
  assertContext();
  return entries;
}
