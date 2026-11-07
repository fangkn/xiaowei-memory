const MAX_URL_LENGTH = 4096;
const unsafeCharacters = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\<>"']/u;
const encodedControls = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;
const horizontalSpace = /[ \t\u00a0\u3000]/u;
const labelBoundary = /[\s，。；：！？、,;:!?()（）\[\]【】「」“”"'<>]/u;
const genericLabels = new Set(['网页链接', '查看原文', '查看全文', '查看详情', '点击查看', '阅读全文', '全文链接', '视频链接', '图片链接', '文章链接']);

/** 只生成无凭据的 HTTP(S) URI；保留搜索话题所需的查询参数和片段。 */
function safeTarget(raw) {
  if (!raw || raw.length > MAX_URL_LENGTH || unsafeCharacters.test(raw) || encodedControls.test(raw) || /%(?![\da-f]{2})/iu.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

/** 单次向前扫描网址与包裹括号；遇到无效输入也不反复扫描同一段文字。 */
function scanTarget(text, start, opening) {
  const close = opening?.char === '（' ? '）' : opening ? ')' : null;
  let asciiDepth = 0, wideDepth = 0, end = start;
  for (; end < text.length; end++) {
    const char = text[end];
    if (/[\s<>"']/u.test(char)) break;
    if (char === '(') asciiDepth++;
    else if (char === ')') {
      if (!asciiDepth) {
        if (close === ')') return {end, after: end + 1, complete: true};
        if (!opening) break;
      } else asciiDepth--;
    } else if (char === '（') wideDepth++;
    else if (char === '）') {
      if (!wideDepth) {
        if (close === '）') return {end, after: end + 1, complete: true};
        if (!opening) break;
      } else wideDepth--;
    }
    if (!opening && /[，。；！？、]/u.test(char)) break;
  }
  if (!opening) while (end > start && /[.,;!?:]/u.test(text[end - 1])) end--;
  return {end, after: end, complete: !opening};
}

/** 在追加网址之前定位明确的链接名称，不猜测整段中文正文的起点。 */
function namedLabel(text, floor, opening, target) {
  let end = opening;
  while (end > floor && horizontalSpace.test(text[end - 1])) end--;
  if (end <= floor) return null;
  const start = Math.max(floor, end - 1024), prefix = text.slice(start, end);
  const suffix = label => label && prefix.endsWith(label) ? {start: end - label.length, end} : null;
  const weiboHost = ['weibo.com', 'www.weibo.com', 's.weibo.com', 'm.weibo.cn'].includes(target.hostname);

  // /n/ 的用户名提供准确边界，允许中文、空格和表情昵称。
  if (['weibo.com', 'www.weibo.com'].includes(target.hostname)) {
    const match = target.pathname.match(/^\/n\/([^/]+)\/?$/u);
    if (match) {
      try {
        const name = decodeURIComponent(match[1]);
        const found = suffix(`@${name}`) || suffix(`＠${name}`);
        if (found) return found;
      } catch { /* 损坏编码不用于猜测名称。 */ }
    }
  }

  // 话题可以紧邻正文或上一条链接；明确的两端 # 本身就是边界。
  if (weiboHost && prefix.endsWith('#')) {
    const hash = prefix.lastIndexOf('#', prefix.length - 2);
    if (hash >= 0 && hash < prefix.length - 2 && !/[\r\n]/u.test(prefix.slice(hash))) return {start: start + hash, end};
  }
  if (weiboHost && prefix.endsWith('＃')) {
    const hash = prefix.lastIndexOf('＃', prefix.length - 2);
    if (hash >= 0 && hash < prefix.length - 2 && !/[\r\n]/u.test(prefix.slice(hash))) return {start: start + hash, end};
  }

  if (weiboHost) {
    const at = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('＠'));
    if (at >= 0 && prefix.length - at <= 160) {
      const label = prefix.slice(at);
      if (label.length > 1 && !/[\s，。；：！？、,;:!?()（）#＃<>]/u.test(label) &&
          (at === 0 || !/[A-Za-z0-9_.+-]/u.test(prefix[at - 1]))) return {start: start + at, end};
    }
  }

  let wordStart = prefix.length;
  while (wordStart > 0 && !labelBoundary.test(prefix[wordStart - 1])) wordStart--;
  const word = prefix.slice(wordStart);
  if (weiboHost && word.endsWith('超话') && word.length > 2 && word.length <= 160 && !/[@#＃]/u.test(word)) return {start: start + wordStart, end};
  if (genericLabels.has(word)) return {start: start + wordStart, end};

  // 引号或书名号明确圈定的名称，也能无歧义地保留为可点击文字。
  const pairs = [['《', '》'], ['「', '」'], ['“', '”'], ['[', ']']];
  for (const [left, right] of pairs) {
    if (!prefix.endsWith(right)) continue;
    const from = prefix.lastIndexOf(left);
    if (from >= 0 && from < prefix.length - 2 && !/[\r\n]/u.test(prefix.slice(from))) return {start: start + from, end};
  }
  return null;
}

/** 把旧正文里的“名称 (网址)”恢复为 PDF 链接片段，原记录与未知语义保持不变。 */
export function parsePdfLinks(value) {
  const text = String(value ?? ''), result = [], pattern = /https?:\/\//giu;
  let cursor = 0, match;
  const append = (content, url) => {
    if (!content) return;
    const previous = result.at(-1);
    if (previous && previous.url === url) previous.text += content;
    else result.push(url ? {text: content, url} : {text: content});
  };
  while ((match = pattern.exec(text))) {
    const start = match.index;
    if (start > 0 && /[A-Za-z0-9_]/u.test(text[start - 1])) continue;
    let before = start;
    while (before > cursor && horizontalSpace.test(text[before - 1])) before--;
    const char = before > cursor ? text[before - 1] : '';
    const opening = char === '(' || char === '（' ? {index: before - 1, char} : null;
    const candidate = scanTarget(text, start, opening);
    pattern.lastIndex = Math.max(start + match[0].length, candidate.after);
    if (!candidate.complete) continue;
    const raw = text.slice(start, candidate.end), target = safeTarget(raw);
    if (!target) continue;
    const label = opening && namedLabel(text, cursor, opening.index, target);
    if (label) {
      append(text.slice(cursor, label.start));
      append(text.slice(label.start, label.end), target.href);
      cursor = candidate.after;
    } else {
      append(text.slice(cursor, start));
      append(raw, target.href);
      cursor = candidate.end;
    }
  }
  append(text.slice(cursor));
  return result;
}
