const ROOT = 'xiaowei-export-cache-v2';
const CHUNK = 1024 * 1024;
function validName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(name) || name === '.' || name === '..') throw new Error('导出临时文件名无效。');
  return name;
}
function storageError(error) {
  if (error?.name === 'QuotaExceededError') return Object.assign(new Error('浏览器临时存储空间不足。已生成的月份会保留，请释放磁盘空间后重试。'), {name: error.name});
  if (['SecurityError', 'NotAllowedError', 'InvalidStateError'].includes(error?.name)) {
    return Object.assign(new Error('当前浏览器阻止创建或读取本地临时文件。请重新加载扩展并刷新微博，使用新版桌面 Chrome 或 Edge，并检查浏览器存储限制后重试。'), {name: error.name, code: 'EXPORT_STORAGE_ACCESS'});
  }
  return error;
}

/** 月份文件与最终 ZIP 写入扩展私有磁盘空间，不堆积在 JavaScript 内存。 */
export async function openExportFiles(job, {storage = globalThis.navigator?.storage} = {}) {
  if (typeof job?.storageId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(job.storageId)) throw new Error('导出临时目录无效。');
  if (typeof storage?.getDirectory !== 'function') throw new Error('当前浏览器不支持本地临时文件，请使用新版桌面 Chrome 或 Edge。');
  let parent, directory;
  try {
    parent = await (await storage.getDirectory()).getDirectoryHandle(ROOT, {create: true});
    directory = await parent.getDirectoryHandle(job.storageId, {create: true});
  } catch (error) { throw storageError(error); }
  const get = async name => {
    try { return await (await directory.getFileHandle(validName(name))).getFile(); }
    catch (error) { if (error?.name === 'NotFoundError') return null; throw storageError(error); }
  };
  const remove = async name => {
    try { await directory.removeEntry(validName(name)); }
    catch (error) { if (error?.name !== 'NotFoundError') throw storageError(error); }
  };
  const createWritable = async name => {
    let writer;
    try { writer = await (await directory.getFileHandle(validName(name), {create: true})).createWritable(); }
    catch (error) { throw storageError(error); }
    return {
      async write(bytes) { try { await writer.write(bytes); } catch (error) { throw storageError(error); } },
      async close() { try { await writer.close(); } catch (error) { throw storageError(error); } },
      async abort() { try { await writer.abort(); } catch { /* 关闭后的流不再需要终止。 */ } },
    };
  };
  return {
    get, remove, createWritable,
    async put(name, bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('月份文件为空。');
      const writer = await createWritable(name);
      try {
        for (let start = 0; start < bytes.length; start += CHUNK) await writer.write(bytes.subarray(start, start + CHUNK));
        await writer.close();
        const file = await get(name);
        if (file?.size !== bytes.byteLength) throw new Error('月份临时文件未完整写入，请重试。');
        return {size: file.size};
      } catch (error) { await writer.abort(); throw error; }
    },
    async cleanup() {
      try { await parent.removeEntry(job.storageId, {recursive: true}); }
      catch (error) { if (error?.name !== 'NotFoundError') throw storageError(error); }
    },
  };
}

export async function cleanupExportJob(job) {
  if (job?.version !== 2 || !job.storageId) return;
  const files = await openExportFiles(job);
  await files.cleanup();
}
