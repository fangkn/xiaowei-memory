import {EXPORT_MEDIA_ORIGINS, normalizeExportMediaURL} from './media-data.js';
import {createReferrerMediaReader} from './media-referrer.js';

const readExportMedia = createReferrerMediaReader({chromeApi: chrome});

function isWeiboPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['weibo.com', 'www.weibo.com'].includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}

// 面板只注入用户点击扩展时的微博标签页，不再打开新的管理标签页。
chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  try {
    if (!isWeiboPage(tab.url)) throw new Error('请在微博个人主页点击扩展，打开悬浮备份面板。');
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['floating-panel.js'] });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    await chrome.action.setTitle({ tabId: tab.id, title: '打开小微记忆悬浮面板' });
  } catch (error) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: error.message || '请刷新微博后重新打开备份面板。' });
    console.error('无法打开小微记忆面板：', error);
  }
});

// 导出兼容入口只接受扩展自己生成的文件，不提供任意网址下载或下载历史查询。
function handleExportMessage(message, sendResponse) {
  const fail = error => sendResponse({ ok: false, error });
  if (message.type === 'WOB_EXPORT_PERMISSION') {
    const error = '无法申请图片读取权限，请重新加载扩展并刷新微博后重试，或取消“包含图片”。';
    try {
      if (typeof chrome.permissions?.request !== 'function') { fail(error); return false; }
      // 必须在收到点击消息的同一调用栈发起，不能先 await 查询权限而丢失用户激活。
      const request = chrome.permissions.request({ origins: EXPORT_MEDIA_ORIGINS });
      Promise.resolve(request).then(granted => sendResponse({ ok: true, granted: granted === true }), () => fail(error));
      return true;
    } catch { fail(error); return false; }
  }
  if (message.type === 'WOB_EXPORT_DOWNLOAD') {
    const prefix = `blob:${chrome.runtime.getURL('')}`;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const filename = /^weibo-\d{4,20}-(?:(?:\d{4}-(?:0[1-9]|1[0-2])|unknown|monthly|combined)-originals|monthly-part\d{3,6})-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3])-[0-5]\d-[0-5]\d-\d{3}Z\.(?:pdf|zip)$/;
    if (typeof message.url !== 'string' || !message.url.startsWith(prefix) || !uuid.test(message.url.slice(prefix.length)) ||
        typeof message.filename !== 'string' || !filename.test(message.filename) ||
        (message.filename.includes('-monthly-part') && !message.filename.endsWith('.zip')) ||
        (message.filename.includes('-combined-originals-') && !message.filename.endsWith('.pdf')) ||
        (message.saveAs !== undefined && typeof message.saveAs !== 'boolean')) {
      fail('导出文件信息无效，请重新生成文件。'); return false;
    }
    const error = '下载未能启动，请重新加载扩展、刷新微博后重试。';
    try {
      if (typeof chrome.downloads?.download !== 'function') { fail(error); return false; }
      const download = chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: message.saveAs ?? true });
      Promise.resolve(download).then(downloadId => {
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) { fail(error); return; }
        sendResponse({ ok: true, downloadId });
      }, () => fail('下载未能启动或已取消，请重试。'));
      return true;
    } catch { fail(error); return false; }
  }
  if (message.type === 'WOB_EXPORT_MEDIA') {
    const resolvedUrl = normalizeExportMediaURL(message.url);
    if (!resolvedUrl) { fail('图片地址无效，不是受支持的微博图片地址。'); return false; }
    (async () => {
      const granted = typeof chrome.permissions?.contains === 'function' &&
        await chrome.permissions.contains({origins: [new URL(resolvedUrl).origin + '/*']});
      if (!granted) throw new Error('尚未允许读取微博图片，请重新点击下载并允许图片权限。');
      const {bytes, mime} = await readExportMedia(resolvedUrl);
      // Chrome runtime messages are JSON; base64 avoids a much larger number array.
      const chunks = [];
      for (let at = 0; at < bytes.length; at += 32768) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 32768)));
      sendResponse({ok: true, mime, base64: btoa(chunks.join(''))});
    })().catch(error => fail(error?.message || '图片读取失败，请稍后重试。'));
    return true;
  }
  if (message.type === 'WOB_EXPORT_DOWNLOAD_STATE') {
    if (!Number.isSafeInteger(message.downloadId) || message.downloadId < 0) {
      fail('下载记录无效，请重新导出。'); return false;
    }
    const error = '无法核对下载状态，请稍后重试；若扩展已更新，请刷新微博后重新导出。';
    try {
      if (typeof chrome.downloads?.search !== 'function') { fail(error); return false; }
      const search = chrome.downloads.search({ id: message.downloadId });
      Promise.resolve(search).then(items => {
        const item = Array.isArray(items) ? items.find(item => item.id === message.downloadId && item.byExtensionId === chrome.runtime.id) : null;
        const missingCompletedFile = item?.state === 'complete' && item.exists === false;
        const state = !missingCompletedFile && ['in_progress', 'interrupted', 'complete'].includes(item?.state) ? item.state : 'unknown';
        sendResponse({ ok: true, state });
      }, () => fail(error));
      return true;
    } catch { fail(error); return false; }
  }
  return false;
}

// 只接受本扩展面板 iframe 的固定消息；来源标签页由浏览器提供，不信任消息中的 tabId。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['WOB_PANEL_CONTEXT', 'WOB_PANEL_MINIMIZE', 'WOB_PANEL_CLOSE', 'WOB_PANEL_RESIZE', 'WOB_PANEL_ACTIVITY',
    'WOB_EXPORT_PERMISSION', 'WOB_EXPORT_DOWNLOAD', 'WOB_EXPORT_DOWNLOAD_STATE', 'WOB_EXPORT_MEDIA'].includes(message?.type)) return false;
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== dashboardUrl || !(sender.frameId > 0) ||
      !Number.isInteger(sender.tab?.id) || !isWeiboPage(sender.tab.url)) {
    sendResponse({ ok: false, error: '面板来源无效，请从微博主页重新点击扩展。' });
    return false;
  }
  if (message.type.startsWith('WOB_EXPORT_')) return handleExportMessage(message, sendResponse);
  if (message.type === 'WOB_PANEL_CONTEXT') {
    sendResponse({ ok: true, tabId: sender.tab.id });
    return false;
  }
  const payload = { type: message.type };
  if (message.type === 'WOB_PANEL_RESIZE') {
    if (!Number.isFinite(message.height)) { sendResponse({ ok: false }); return false; }
    payload.height = Math.max(180, Math.min(720, Math.ceil(message.height)));
  }
  if (message.type === 'WOB_PANEL_ACTIVITY') {
    if (!['idle', 'collecting', 'exporting'].includes(message.state)) { sendResponse({ ok: false }); return false; }
    payload.state = message.state;
  }
  chrome.tabs.sendMessage(sender.tab.id, payload, { frameId: 0 }).then(sendResponse, () => {
    sendResponse({ ok: false, error: '微博页面已刷新，请再次点击扩展。' });
  });
  return true;
});
