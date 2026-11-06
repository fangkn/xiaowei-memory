import {MAX_MEDIA_BYTES, EXPORT_MEDIA_ORIGINS, usableExportMedia, normalizeExportMediaURL} from './media-data.js';

// 部分嵌入环境不暴露权限、下载 API；仅将固定导出操作交给扩展后台。
const reconnectMessage = '无法连接扩展后台，请在扩展管理页重新加载小微记忆，再刷新微博后重试。';
const staleContextMessage = '当前浮窗已失效。请刷新微博页面，再点击“小微记忆”重新打开。已保存的本机记录会保留。';

export function normalizeExtensionError(error) {
  const message = error?.message || String(error || '操作失败，请重试。');
  if (error?.code === 'EXTENSION_CONTEXT_INVALIDATED' || /extension context invalidated/i.test(message)) {
    return Object.assign(new Error(staleContextMessage), {code: 'EXTENSION_CONTEXT_INVALIDATED'});
  }
  return error && typeof error.message === 'string' ? error : new Error(message);
}

export function assertExtensionContext() {
  try {
    const runtime = globalThis.chrome?.runtime;
    // Chrome 使旧上下文失效后，runtime.id 会变为 undefined；检查无需异步等待。
    if (typeof runtime?.id !== 'string' || !runtime.id) throw new Error('Extension context invalidated.');
    if (typeof runtime.getManifest === 'function') runtime.getManifest();
  } catch (error) { throw normalizeExtensionError(error); }
}

function browserOperation(start) {
  try {
    assertExtensionContext();
    // 同步调用 API，保留图片权限请求所需的用户激活。
    return Promise.resolve(start()).catch(error => { throw normalizeExtensionError(error); });
  } catch (error) { return Promise.reject(normalizeExtensionError(error)); }
}

function exportMessage(message) {
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== 'function') return Promise.reject(new Error(reconnectMessage));
  try {
    // 必须在点击事件中直接发出，不能先等待数据库读取或其他异步操作。
    return Promise.resolve(runtime.sendMessage(message)).then(response => {
      if (!response?.ok) throw new Error(response?.error || reconnectMessage);
      return response;
    }, error => {
      const normalized = normalizeExtensionError(error);
      throw normalized.code === 'EXTENSION_CONTEXT_INVALIDATED' ? normalized : new Error(reconnectMessage);
    });
  } catch (error) {
    const normalized = normalizeExtensionError(error);
    return Promise.reject(normalized.code === 'EXTENSION_CONTEXT_INVALIDATED' ? normalized : new Error(reconnectMessage));
  }
}

export function requestImagePermission() {
  return browserOperation(() => {
    if (typeof globalThis.chrome?.permissions?.request === 'function') {
      return chrome.permissions.request({origins: EXPORT_MEDIA_ORIGINS});
    }
    return exportMessage({type: 'WOB_EXPORT_PERMISSION'}).then(result => result.granted === true);
  });
}

export function downloadExport({url, filename, saveAs = true}) {
  return browserOperation(() => {
    if (typeof saveAs !== 'boolean') throw new Error('下载方式无效，请重新导出。');
    if (typeof globalThis.chrome?.downloads?.download === 'function') {
      return chrome.downloads.download({url, filename, saveAs});
    }
    return exportMessage({type: 'WOB_EXPORT_DOWNLOAD', url, filename, saveAs}).then(result => {
      if (!Number.isSafeInteger(result.downloadId) || result.downloadId < 0) throw new Error('浏览器没有返回下载记录，请重试导出。');
      return result.downloadId;
    });
  });
}

export function requestExportMedia(url) {
  return browserOperation(async () => {
    const resolvedUrl = normalizeExportMediaURL(url);
    if (!resolvedUrl) throw new Error('图片地址无效，不是受支持的微博图片地址。');
    const result = await exportMessage({type: 'WOB_EXPORT_MEDIA', url: resolvedUrl});
    if (typeof result.base64 !== 'string' || result.base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) {
      throw new Error('图片数据无效或超过单张 12 MiB 上限。');
    }
    let bytes;
    try { bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)); }
    catch { throw new Error('图片数据损坏，请重试。'); }
    const media = {url, resolvedUrl, bytes, mime: result.mime};
    if (!usableExportMedia(media)) throw new Error('图片数据无效，请重新读取。');
    return media;
  });
}

export function exportDownloadState(downloadId) {
  return browserOperation(async () => {
    if (typeof globalThis.chrome?.downloads?.search === 'function') {
      const [download] = await chrome.downloads.search({id: downloadId});
      return download?.state === 'complete' && download.exists === false ? 'unknown' : download?.state || 'unknown';
    }
    const result = await exportMessage({type: 'WOB_EXPORT_DOWNLOAD_STATE', downloadId});
    return result.state;
  });
}
