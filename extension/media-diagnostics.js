// 诊断只关联现有快照，不重写记录或导出修订，完整月份仍可复用。
const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);

export function mediaFailureDetails(records, failures, {includeVersions = false} = {}) {
  const reasons = new Map(failures.map(item => [item.url, text(item.reason)])), details = [];
  for (const post of records) {
    const snapshots = includeVersions ? [post, ...(post.versions || [])] : [post];
    for (const snapshot of snapshots) {
      const references = [
        ...(Array.isArray(snapshot.images) ? snapshot.images : []).map(url => ({url, kind: 'image'})),
        ...(!includeVersions && Array.isArray(snapshot.emoticons) ? snapshot.emoticons : []).filter(item => String(snapshot.text || '').includes(item.text)).map(item => ({url: item.url, kind: 'emoticon'})),
      ];
      for (const reference of references) if (reasons.has(reference.url)) {
        details.push({postId: text(post.id), postUrl: text(snapshot.url || post.url), url: text(reference.url), kind: reference.kind, reason: reasons.get(reference.url)});
      }
    }
  }
  return details;
}

export function enrichMediaFailures(details, downloadFailures, normalizeURL) {
  const reasons = new Map(downloadFailures.map(item => [text(item.url), text(item.reason)])), seen = new Set();
  return details.map(item => ({
    postId: text(item.postId), postUrl: text(item.postUrl), url: text(item.url),
    requestUrl: normalizeURL(item.url) || '', kind: text(item.kind),
    reason: reasons.get(text(item.url)) || text(item.reason) || '附件未能写入文件。',
  })).filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// 所有地址均作为文本显示；不创建来自记录的 HTML 或可执行链接。
export function formatExportFailures(failures) {
  return failures.map(failure => {
    const heading = `${text(failure.month) || '未知月份'}：${text(failure.reason) || '本月未完成'}`;
    const attachments = Array.isArray(failure.attachments) ? failure.attachments : [];
    const entries = attachments.map((item, index) => {
      const lines = [`${index + 1}. ${item.kind === 'image' ? '图片' : item.kind === 'unicode' ? '系统表情' : '微博表情'} · 微博 ${text(item.postId) || '未知 ID'}`,
        `微博原文：${text(item.postUrl) || '原记录未提供链接'}`,
        `图片地址：${text(item.url) || (item.kind === 'unicode' ? '本机绘制，无远程图片地址' : '原记录未提供有效地址')}`];
      if (item.requestUrl && item.requestUrl !== item.url) lines.push(`尝试地址：${text(item.requestUrl)}`);
      lines.push(`原因：${text(item.reason) || '附件未能写入文件。'}`);
      return lines.join('\n');
    });
    return [heading, ...entries].join('\n\n');
  }).join('\n\n────────\n\n');
}
