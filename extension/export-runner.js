import {openExportFiles, cleanupExportJob} from './export-files.js';
import {writeStreamingZip} from './zip-stream.js';
import {readStoredZipEntries} from './zip-reader.js';
import {MONTH_DIRECTORY_LAYOUT as MARKDOWN_LAYOUT} from './archive.js';
export {cleanupExportJob};

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const MONTH = /^(?:\d{4}-(?:0[1-9]|1[0-2])|unknown)$/;
const monthDirectory = month => month === 'unknown' ? '未知日期' : month;
function scope(uid, options = {}) {
  const owner = String(uid || ''), format = options.format || 'pdf';
  if (!/^\d{4,20}$/.test(owner) || !['pdf', 'pdf-combined', 'markdown'].includes(format)) throw new Error('导出账号或格式无效。');
  return {uid: owner, format, images: options.images === true};
}
function planFor(uid, batches) {
  if (!Array.isArray(batches) || !batches.length) throw new Error('没有待导出的月份。');
  const seen = new Set();
  return batches.map(batch => {
    if (String(batch.uid) !== uid || !MONTH.test(batch.month) || seen.has(batch.month) ||
        typeof batch.revision !== 'string' || !batch.revision || !Array.isArray(batch.posts) || !batch.posts.length) throw new Error('月份快照无效，请重新选择导出范围。');
    seen.add(batch.month);
    return {month: batch.month, revision: batch.revision, postCount: batch.posts.length};
  });
}
export function exportJobKey(uid, options = {}) {
  const settings = scope(uid, options);
  return `export-job:v2:${settings.format}:${settings.images ? 'images' : 'text'}:${settings.uid}`;
}
export function createExportJob(uid, options, batches) {
  const settings = scope(uid, options), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {version: 2, ...settings, ...(settings.format === 'markdown' ? {markdownLayout: MARKDOWN_LAYOUT} : {}), plan: planFor(settings.uid, batches), stamp,
    storageId: `${settings.uid}-${stamp}-${crypto.randomUUID()}`, files: [], downloads: [], failures: []};
}
export function matchesExportJob(job, uid, options, batches) {
  try {
    const settings = scope(uid, options);
    return job?.version === 2 && job.uid === settings.uid && job.format === settings.format && job.images === settings.images &&
      (settings.format !== 'markdown' || job.markdownLayout === MARKDOWN_LAYOUT) &&
      STAMP.test(job.stamp) && typeof job.storageId === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(job.storageId) &&
      Array.isArray(job.files) && Array.isArray(job.downloads) && Array.isArray(job.failures) &&
      JSON.stringify(job.plan) === JSON.stringify(planFor(settings.uid, batches));
  } catch { return false; }
}
function containsWholePlan(items, plan) {
  return Array.isArray(items) && Array.isArray(plan) && plan.length > 0 && items.length === plan.length &&
    items.every((item, index) => item?.month === plan[index].month && item.revision === plan[index].revision && item.postCount === plan[index].postCount);
}
function combinedFileRecord(job) {
  return (job?.files || []).find(item => item.name === 'combined.pdf' && containsWholePlan(item.months, job.plan) &&
    Number.isSafeInteger(item.size) && item.size > 0 && Number.isSafeInteger(item.failedImageCount) && item.failedImageCount >= 0 &&
    Number.isSafeInteger(item.savedImageCount) && item.savedImageCount >= 0);
}
// 已生成与已下载分别记录；附件缺失的文件可供查看，但不能被当作完整月份。
export function generatedExportMonths(job) {
  const plan = new Map((job?.plan || []).map(item => [item.month, item.revision])), months = new Map();
  if (job?.format === 'markdown' && job.markdownLayout !== MARKDOWN_LAYOUT) return months;
  if (job?.format === 'pdf-combined') {
    const file = combinedFileRecord(job);
    // 文件尺寸与附件计数属于整本；月份映射只用于整体进度和修订记账。
    if (file) for (const month of file.months) months.set(month.month, {...file,
      month: month.month, revision: month.revision, postCount: month.postCount, combined: true});
    return months;
  }
  for (const item of job?.files || []) {
    if (plan.get(item.month) === item.revision && item.name === `${item.month}.${job.format === 'pdf' ? 'pdf' : 'zip'}` &&
        Number.isSafeInteger(item.size) && item.size > 0 && Number.isSafeInteger(item.failedImageCount) && item.failedImageCount >= 0 &&
        Number.isSafeInteger(item.savedImageCount) && item.savedImageCount >= 0) months.set(item.month, item);
  }
  return months;
}
export function completedExportMonths(job) {
  const plan = new Map((Array.isArray(job?.plan) ? job.plan : []).map(item => [item.month, item.revision])), completed = new Map();
  if (job?.format === 'markdown' && job.markdownLayout !== MARKDOWN_LAYOUT) return completed;
  for (const download of Array.isArray(job?.downloads) ? job.downloads : []) {
    if (download.state !== 'complete' || !Number.isSafeInteger(download.downloadId) || download.downloadId < 0) continue;
    // 合并文件只能整本确认；不能合并多个不完整回执，也不能确认有附件缺失的部分月份。
    if (job?.format === 'pdf-combined' && (download.combined !== true || !containsWholePlan(download.months, job.plan) ||
        !download.months.every(month => month.failedImageCount === 0))) continue;
    for (const month of Array.isArray(download.months) ? download.months : []) {
      if (month.failedImageCount === 0 && plan.get(month.month) === month.revision) completed.set(month.month, {...month, downloadId: download.downloadId, filename: download.filename, part: 1});
    }
  }
  return completed;
}
function failedMonthNames(job) {
  const plan = new Map(job.plan.map(item => [item.month, item.revision])), failed = new Set();
  for (const item of job.failures) if (plan.get(item.month) === item.revision) failed.add(item.month);
  for (const item of generatedExportMonths(job).values()) if (item.failedImageCount) failed.add(item.month);
  return [...failed];
}
function recordFailure(job, batch, reason, attachments = []) {
  job.failures = job.failures.filter(item => item.month !== batch.month);
  if (reason) {
    // 详情与月份检查点一起保存，刷新或升级后仍能定位失败微博；不保存图片字节。
    const details = (Array.isArray(attachments) ? attachments : []).filter(item => item && typeof item === 'object')
      .map(item => Object.fromEntries(['postId', 'postUrl', 'url', 'requestUrl', 'kind', 'reason']
        .map(key => [key, typeof item[key] === 'string' ? item[key] : ''])));
    job.failures.push({month: batch.month, revision: batch.revision, reason: String(reason).slice(0, 1000), attachments: details});
  }
}
function archiveFailureDetails(failures) {
  // 浮窗与本机检查点保留完整地址；可分享的 ZIP 清单不携带查询参数或 URL 凭据。
  const link = value => {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      url.search = ''; url.hash = ''; return url.href;
    } catch { return ''; }
  };
  return failures.map(({revision, attachments, ...failure}) => ({...failure,
    attachments: (Array.isArray(attachments) ? attachments : []).map(item => ({...item,
      postUrl: link(item.postUrl), url: link(item.url), requestUrl: link(item.requestUrl)}))}));
}
function interruptedError(state, combined = false) {
  const error = new Error(combined
    ? (state === 'interrupted' ? '合并 PDF 下载已取消或中断。已生成的文件会保留，点击继续可重新下载。' : '暂时无法确认合并 PDF 下载状态。已生成的文件会保留，请检查浏览器下载记录后重试。')
    : (state === 'interrupted' ? '压缩包下载已取消或中断。已生成的月份会保留，点击继续可重新打包下载。' : '暂时无法确认压缩包下载状态。已生成的月份会保留，请检查浏览器下载记录后重试。'));
  error.code = state === 'interrupted' ? 'EXPORT_DOWNLOAD_INTERRUPTED' : 'EXPORT_DOWNLOAD_UNKNOWN';
  return error;
}

/** 按月生成后打包，或一次生成合并 PDF；临时文件落盘并核对最终下载回执。 */
export async function runExportJob({job, batches, options}, deps) {
  if (!matchesExportJob(job, job?.uid, options, batches)) throw new Error('导出任务与当前月份快照不一致，请重新开始。');
  const combined = job.format === 'pdf-combined';
  for (const name of [combined ? 'prepareCombined' : 'prepareMonth', 'downloadFile', 'downloadState', 'saveJob']) if (typeof deps?.[name] !== 'function') throw new Error(`导出依赖缺失：${name}`);
  const assertContext = deps.assertContext || (() => {}), sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const createUrl = deps.createObjectURL || (blob => URL.createObjectURL(blob)), revokeUrl = deps.revokeObjectURL || (url => URL.revokeObjectURL(url));
  const total = job.plan.length, multiple = total > 1;
  let currentMonth = '', currentIndex = 0, reused = 0, packing = {packedBytes: 0, totalBytes: 0};
  const emit = phase => {
    const generated = generatedExportMonths(job), failed = failedMonthNames(job);
    deps.onProgress?.({total, generated: generated.size, ready: [...generated.values()].filter(item => !item.failedImageCount).length,
      completed: completedExportMonths(job).size, currentMonth, currentIndex, reused, part: 1, phase, combined,
      failedMonths: failed.length, failedMonthNames: failed, ...packing});
  };
  const persist = () => deps.saveJob(job);
  async function waitForDownload(receipt, initialState) {
    let state = initialState, unknownChecks = 0;
    while (true) {
      assertContext();
      if (state === undefined) state = await deps.downloadState(receipt.downloadId);
      if (state === 'complete') return;
      if (state === 'interrupted') { receipt.state = state; await persist(); throw interruptedError(state, combined); }
      if (state !== 'in_progress') {
        if (++unknownChecks >= 10) { receipt.state = 'unknown'; await persist(); throw interruptedError('unknown', combined); }
      } else unknownChecks = 0;
      emit('downloading'); await sleep(500); state = undefined;
    }
  }
  assertContext();
  for (const receipt of job.downloads) {
    if (!Number.isSafeInteger(receipt.downloadId) || receipt.downloadId < 0) { receipt.state = 'unknown'; continue; }
    const state = await deps.downloadState(receipt.downloadId);
    if (state === 'in_progress') { await waitForDownload(receipt, state); receipt.state = 'complete'; }
    else receipt.state = ['complete', 'interrupted'].includes(state) ? state : 'unknown';
  }
  await persist();
  if (completedExportMonths(job).size === total) { emit('complete'); return job; }
  const files = await (deps.openFiles || openExportFiles)(job);
  // 索引只在文件成功落盘后写入；刷新后核对尺寸，缺失文件会重新生成。
  const cachedFiles = combined ? [combinedFileRecord(job)].filter(Boolean) : [...generatedExportMonths(job).values()];
  for (const item of cachedFiles) {
    const file = await files.get(item.name);
    if (file?.size !== item.size) job.files = combined ? [] : job.files.filter(record => record.month !== item.month);
  }
  reused = [...generatedExportMonths(job).values()].filter(item => item.failedImageCount === 0).length;
  await persist(); emit('preparing');
  if (combined) {
    const previous = combinedFileRecord(job);
    if (!previous || previous.failedImageCount) {
      // 整本重新生成前撤销旧索引，失败后不能下载旧的缺页或缺图文件。
      job.files = [];
      await persist(); assertContext(); emit('generating');
      let result;
      try {
        result = await deps.prepareCombined(batches);
        assertContext();
        if (!(result?.bytes instanceof Uint8Array) || !result.bytes.length || result.extension !== 'pdf' || result.mime !== 'application/pdf' ||
            !Number.isSafeInteger(result.failedImageCount) || result.failedImageCount < 0 || !Number.isSafeInteger(result.savedImageCount) || result.savedImageCount < 0) throw new Error('合并 PDF 生成结果无效，请重试。');
      } catch (error) {
        assertContext();
        if (error?.code === 'EXTENSION_CONTEXT_INVALIDATED') throw error;
        for (const batch of batches) recordFailure(job, batch, error?.message || '合并 PDF 生成失败');
        await persist(); emit('partial'); return job;
      }
      const written = await files.put('combined.pdf', result.bytes);
      if (written?.size !== result.bytes.length) throw new Error('合并 PDF 临时文件未完整写入，请重试。');
      const detailIds = new Set(batches.flatMap(batch => batch.posts.map(post => String(post.id))));
      for (const [index, batch] of batches.entries()) {
        const postIds = new Set(batch.posts.map(post => String(post.id)));
        const attachments = (Array.isArray(result.attachmentFailures) ? result.attachmentFailures : []).filter(item => postIds.has(String(item?.postId)) || index === 0 && !detailIds.has(String(item?.postId)));
        recordFailure(job, batch, result.failedImageCount ? `合并 PDF 有 ${result.failedImageCount} 张图片或表情未完成，需重新生成整本。${typeof result.failureReason === 'string' ? result.failureReason : ''}` : '', attachments);
      }
      job.files = [{name: 'combined.pdf', size: written.size, months: job.plan.map(item => ({...item})), pageCount: result.pageCount || null,
        failedImageCount: result.failedImageCount, savedImageCount: result.savedImageCount}];
      result = null;
      await persist(); emit('generated');
    } else {
      for (const batch of batches) recordFailure(job, batch, '');
      await persist();
    }
  } else for (const [index, batch] of batches.entries()) {
    const previous = generatedExportMonths(job).get(batch.month);
    if (previous && previous.failedImageCount === 0) { recordFailure(job, batch, ''); continue; }
    currentMonth = batch.month; currentIndex = index + 1;
    assertContext(); emit('generating');
    let result;
    try {
      result = await deps.prepareMonth(batch);
      assertContext();
      const extension = job.format === 'pdf' ? 'pdf' : 'zip';
      if (!(result?.bytes instanceof Uint8Array) || !result.bytes.length || result.extension !== extension ||
          result.mime !== (extension === 'pdf' ? 'application/pdf' : 'application/zip') ||
          !Number.isSafeInteger(result.failedImageCount) || result.failedImageCount < 0 || !Number.isSafeInteger(result.savedImageCount) || result.savedImageCount < 0) throw new Error('本月生成结果无效，请重试。');
    } catch (error) {
      assertContext();
      if (error?.code === 'EXTENSION_CONTEXT_INVALIDATED') throw error;
      // 旧的有缺失 PDF 不能在本轮生成失败后被包装成成功的新结果。
      job.files = job.files.filter(item => item.month !== batch.month);
      recordFailure(job, batch, error?.message || '本月生成失败');
      await persist(); emit('failed'); continue;
    }
    const name = `${batch.month}.${result.extension}`;
    const written = await files.put(name, result.bytes);
    if (written?.size !== result.bytes.length) throw new Error('月份临时文件未完整写入，请重试。');
    const item = {month: batch.month, revision: batch.revision, postCount: batch.posts.length, name, size: written.size,
      pageCount: result.pageCount || null, failedImageCount: result.failedImageCount, savedImageCount: result.savedImageCount};
    recordFailure(job, batch, result.failedImageCount ? `有 ${result.failedImageCount} 张图片或表情未能写入文件，请重试本月。${typeof result.failureReason === 'string' ? result.failureReason : ''}` : '', result.attachmentFailures);
    result = null;
    job.files = job.files.filter(record => record.month !== batch.month); job.files.push(item);
    await persist(); emit('generated');
  }
  currentMonth = '';
  const generated = generatedExportMonths(job);
  if (generated.size !== total) { emit('partial'); return job; }
  assertContext();
  const months = job.plan.map(item => generated.get(item.month));
  const filename = combined ? `weibo-${job.uid}-combined-originals-${job.stamp}.pdf` : multiple ? `weibo-${job.uid}-monthly-originals-${job.stamp}.zip` : `weibo-${job.uid}-${months[0].month}-originals-${job.stamp}.${job.format === 'pdf' ? 'pdf' : 'zip'}`;
  let file;
  if (!combined && (multiple || job.format === 'markdown')) {
    const markdown = job.format === 'markdown';
    const manifest = new Blob([JSON.stringify({uid: job.uid, format: job.format, originalOnly: true, allHistoryGuaranteed: false,
      ...(markdown ? {archiveLayout: MARKDOWN_LAYOUT} : {}),
      months: months.map(({name, revision, size, ...item}) => markdown ? {...item, directory: monthDirectory(item.month)} : item),
      failures: archiveFailureDetails(job.failures)}, null, 2)], {type: 'application/json'});
    const entries = [];
    emit('packing');
    // 月 ZIP 仅作为内部断点缓存；最终 ZIP 直接写入各月笔记和图片，不嵌套压缩包。
    if (markdown) for (const item of months) {
      assertContext();
      let members;
      try {
        const cached = await files.get(item.name);
        if (cached?.size !== item.size) throw new Error('月份临时文件已变化，请重试。');
        members = await readStoredZipEntries(cached, {assertContext});
        const directory = monthDirectory(item.month);
        if (!members.every(entry => entry.name.startsWith(`${directory}/`) && !entry.name.endsWith('.zip')) ||
            !members.some(entry => entry.name === `${directory}/${directory}.md`) ||
            !members.some(entry => entry.name === `${directory}/manifest.json`)) throw new Error('月份目录不完整或格式已过期，请重试。');
      } catch (error) {
        assertContext();
        job.files = job.files.filter(record => record.month !== item.month);
        recordFailure(job, item, error?.message || '月份缓存读取失败');
        await persist();
        throw error;
      }
      if (entries.length + members.length + 1 > 65535) throw new Error('月份中的文件总数超过 ZIP32 的 65,535 项限制，请缩小所选月份范围。');
      entries.push(...members);
    }
    else entries.push(...months.map(item => ({name: `weibo-${job.uid}-${item.month}-originals.pdf`, size: item.size, open: () => files.get(item.name)})));
    entries.push({name: 'manifest.json', size: manifest.size, open: async () => manifest});
    const writer = await files.createWritable('archive.zip');
    try {
      emit('packing');
      const packed = await writeStreamingZip(entries, writer, {assertContext, onProgress: value => {packing = value; emit('packing');}});
      await writer.close();
      file = await files.get('archive.zip');
      if (file?.size !== packed.size) throw new Error('压缩包临时文件未完整写入，请重试。');
    } catch (error) {
      await writer.abort();
      try { await files.remove('archive.zip'); } catch { /* 后续重试会覆盖未完成的压缩包。 */ }
      if (markdown && ['ZIP_SOURCE_CRC_MISMATCH','ZIP_SOURCE_CHANGED'].includes(error?.code)) {
        const damaged = months.find(item => error.entryName?.startsWith(`${monthDirectory(item.month)}/`));
        if (damaged) {
          job.files = job.files.filter(record => record.month !== damaged.month);
          recordFailure(job, damaged, error.message);
          await persist();
        }
      }
      throw error;
    }
  } else file = await files.get(months[0].name);
  assertContext();
  if (!file || !file.size) throw new Error('导出文件丢失，请重试。');
  const mime = !combined && (multiple || job.format === 'markdown') ? 'application/zip' : 'application/pdf';
  const url = createUrl(file.type === mime ? file : file.slice(0, file.size, mime));
  try {
    emit('downloading');
    const downloadId = await deps.downloadFile({url, filename, saveAs: true});
    if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error('浏览器没有返回下载记录，请重试。');
    const receipt = {part: 1, filename, downloadId, state: 'in_progress', ...(combined ? {combined: true} : {}),
      months: months.map(({name, size, months: _wholePlan, ...item}) => item)};
    job.downloads.push(receipt); await persist();
    await waitForDownload(receipt);
    receipt.state = 'complete'; await persist();
  } finally { revokeUrl(url); }
  emit(completedExportMonths(job).size === total ? 'complete' : 'partial');
  return job;
}
