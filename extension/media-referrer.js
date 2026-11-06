import {fetchExportMedia, validExportMediaURL} from './media-data.js';

// 固定 ID 仅属于本模块；不删除其他规则，也不安装浏览器重启后继续存在的动态规则。
export const MEDIA_REFERRER_RULE_ID = 710071;

export function mediaReferrerRule(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('扩展连接无效，请重新加载扩展后刷新微博。');
  return {
    id: MEDIA_REFERRER_RULE_ID, priority: 1,
    action: {type: 'modifyHeaders', requestHeaders: [{header: 'Referer', operation: 'set', value: 'https://weibo.com/'}]},
    condition: {urlFilter: '|https://', requestDomains: ['sinaimg.cn', 'img.t.sinajs.cn', 'face.t.sinajs.cn'], initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest'], requestMethods: ['get']},
  };
}

// fetch 不能跨来源指定 Referer。只在本扩展读取新浪图片期间由浏览器补充固定微博来源。
// 使用串行队列保证多个面板同时读图时，一个请求的 finally 不会提前移除另一个请求的规则。
export function createReferrerMediaReader({chromeApi = globalThis.chrome, fetchMedia = fetchExportMedia} = {}) {
  const update = options => {
    if (typeof chromeApi?.declarativeNetRequest?.updateSessionRules !== 'function') {
      throw new Error('图片来源兼容功能尚未加载，请在扩展管理页重新加载小微记忆，再刷新微博。');
    }
    return chromeApi.declarativeNetRequest.updateSessionRules(options);
  };
  const remove = () => update({removeRuleIds: [MEDIA_REFERRER_RULE_ID]});
  // 每次 service worker 启动先清除中断可能遗留的规则；下一次安装也以原子替换清理同一 ID。
  let queue = Promise.resolve().then(remove).catch(() => {});
  return function readMedia(url) {
    if (!validExportMediaURL(url)) return Promise.reject(new Error('图片地址无效，仅支持 HTTPS 微博图片地址。'));
    const result = queue.then(async () => {
      const rule = mediaReferrerRule(chromeApi?.runtime?.id);
      try { await update({removeRuleIds: [MEDIA_REFERRER_RULE_ID], addRules: [rule]}); }
      catch { throw new Error('无法设置微博图片来源，请在扩展管理页重新加载小微记忆，确认图片权限后重试。'); }
      try { return await fetchMedia(url); }
      finally {
        try { await remove(); }
        catch { throw new Error('图片来源设置未能恢复，请重新加载小微记忆后重试。'); }
      }
    });
    queue = result.catch(() => {});
    return result;
  };
}
