/* Weibo page adapter. No private API, credentials, or network requests. */
(() => {
  'use strict';
  if (globalThis.WOBAdapter) return;
  const selectors = {
    text: '.wbpro-feed-ogText > [class*="_wbtext_"], [class*="detail_wbtext"], [class*="Feed_detail"], .weibo-text, .WB_text, [node-type="feed_list_content"], [data-testid="post-text"]',
    // Match quoted-content containers, never the retweet action/icon in a footer.
    repost: '.retweet, [class*="_retweet_"], [class*="Retweet_"], [class*="repost_wrap"], .wbpro-feed-reText, .card-comment, .WB_feed_expand, [node-type="feed_list_forwardContent"], [data-testid="repost"]',
    author: 'header a[usercard], [class*="head_name"], .m-text-box h3, .WB_info a, [node-type="feed_list_originNick"], [data-testid="author"]',
    time: 'header a[class*="_time_"], a[class*="head_time"], .WB_from a, a[href*="/status/"], a[href*="/detail/"], [data-testid="post-time"]',
    cards: 'article, [data-testid="weibo-post"], .WB_feed_detail, .card-wrap, .vue-recycle-scroller__item-view'
  };
  function normalizeSpace(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function safeURL(value, base = 'https://weibo.com/') {
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      if (!['weibo.com', 'weibo.cn', 'sinaimg.cn'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }
  // 内容脚本不能直接 import 模块；与 media-data 的媒体兼容规则保持一致，不放宽主页和永久链接校验。
  function mediaURL(value) {
    if (typeof value !== 'string' || value.length > 4096) return '';
    const input = value.trim();
    if (!/^(?:https?:\/\/|\/\/)/i.test(input) || /[\u0000-\u001f\u007f\\]/.test(input)) return '';
    try {
      const url = new URL(input.startsWith('//') ? `https:${input}` : input);
      const host = url.hostname;
      if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password ||
          !(host === 'sinaimg.cn' || host.endsWith('.sinaimg.cn') || host === 'img.t.sinajs.cn' || host === 'face.t.sinajs.cn')) return '';
      url.protocol = 'https:'; url.hash = '';
      return url.href.length <= 4096 ? url.href : '';
    } catch { return ''; }
  }
  function permalink(value, base = 'https://weibo.com/') {
    const safe = safeURL(value, base);
    if (!safe) return null;
    const url = new URL(safe);
    if (!(url.hostname === 'weibo.com' || url.hostname.endsWith('.weibo.com') || url.hostname === 'weibo.cn' || url.hostname.endsWith('.weibo.cn'))) return null;
    let match = url.pathname.match(/^\/(\d{4,})\/([A-Za-z0-9]{5,})(?:\/)?$/);
    if (match && !/^\d+$/.test(match[2])) return { uid: match[1], id: match[2], url: `${url.origin}/${match[1]}/${match[2]}` };
    match = url.pathname.match(/^\/(?:status|detail)\/([A-Za-z0-9]{5,})(?:\/)?$/);
    if (match && !/^\d+$/.test(match[1])) return { uid: '', id: match[1], url: `${url.origin}${url.pathname.replace(/\/$/, '')}` };
    return null;
  }
  function profileUid(value) {
    try {
      const safe = safeURL(value, 'https://weibo.com/');
      if (!safe) return '';
      const url = new URL(safe);
      if (!['weibo.com', 'weibo.cn'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return '';
      return url.pathname.match(/^\/(?:u\/)?(\d{4,})\/?$/)?.[1] || '';
    } catch { return ''; }
  }
  function parseDate(value, now = Date.now()) {
    let raw = normalizeSpace(value);
    const shortYear = raw.match(/^(\d{2})-(\d{1,2})-(\d{1,2})(\s+\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (shortYear) {
      const currentYear = new Date(now).getUTCFullYear();
      let year = Math.floor(currentYear / 100) * 100 + Number(shortYear[1]);
      if (year > currentYear) year -= 100;
      raw = `${year}-${shortYear[2]}-${shortYear[3]}${shortYear[4]}`;
    }
    if (!raw) return null;
    // Only unambiguous absolute dates or explicit relative dates. A month/day
    // without a year is intentionally unknown, not silently assigned this year.
    const absolute = raw.match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日)?(?:[ T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?/);
    if (absolute) {
      const [, y, m, d, hh = '00', mm = '00', ss = '00', offset = '+08:00'] = absolute;
      const nums = [y, m, d, hh, mm, ss].map(Number);
      if (nums[1] < 1 || nums[1] > 12 || nums[2] < 1 || nums[2] > new Date(Date.UTC(nums[0], nums[1], 0)).getUTCDate() || nums[3] > 23 || nums[4] > 59 || nums[5] > 59) return null;
      const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}${offset}`;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    let match = raw.match(/^(\d+)\s*(秒|分钟|小时)前$/);
    if (match) return new Date(now - Number(match[1]) * ({ 秒: 1000, 分钟: 60000, 小时: 3600000 }[match[2]])).toISOString();
    if (raw === '刚刚') return new Date(now).toISOString();
    match = raw.match(/^(今天|昨天)\s*(\d{1,2}):(\d{2})$/);
    if (match && +match[2] < 24 && +match[3] < 60) {
      const beijing = new Date(now + 8 * 3600000 - (match[1] === '昨天' ? 86400000 : 0));
      return new Date(`${beijing.toISOString().slice(0, 10)}T${match[2].padStart(2, '0')}:${match[3]}:00+08:00`).toISOString();
    }
    return null;
  }
  function textOf(element, excludeRepost = false) {
    if (!element) return '';
    const node = element.cloneNode(true);
    node.querySelectorAll('script,style,button,svg,[aria-hidden="true"]').forEach(n => n.remove());
    if (excludeRepost) node.querySelectorAll(selectors.repost).forEach(n => n.remove());
    node.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    node.querySelectorAll('img').forEach(n => n.replaceWith(n.getAttribute('alt') || ''));
    node.querySelectorAll('a,span.expand,span.collapse').forEach(n => {
      if (/^(展开全文|展开|收起全文|收起)$/.test(normalizeSpace(n.textContent))) { n.remove(); return; }
      const href=n.getAttribute('href');if(href){try{const url=new URL(href,'https://weibo.com/');if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!n.textContent.includes(url.href))n.append(` (${url.href})`)}catch{}}
    });
    return normalizeSpace(node.textContent);
  }
  function isInsideRepost(node, card) {
    const ancestor = node.closest(selectors.repost);
    return ancestor && ancestor !== card && card.contains(ancestor);
  }
  function emoticonsOf(element, pageURL = 'https://weibo.com/') {
    const found = [], seen = new Set();
    for (const img of element?.querySelectorAll('img') || []) {
      if (img.closest('script,style,[aria-hidden="true"]') || img.closest(selectors.repost)) continue;
      const text = (img.getAttribute('alt') || '').trim();
      const source = img.getAttribute('data-src') || img.currentSrc || img.getAttribute('src');
      const url = mediaURL(source);
      if (!text || text.length > 80 || !url) continue;
      if (!/^\[[^\]\r\n]+\]$/.test(text) && !/emoji|emoticon|face/i.test(`${img.className || ''} ${url}`)) continue;
      const key = `${text}\n${url}`;
      if (!seen.has(key)) { seen.add(key); found.push({text, url}); }
    }
    return found;
  }
  function cardElements(doc) {
    const articles = [...doc.querySelectorAll('article, [data-testid="weibo-post"]')];
    const cards = articles.length ? articles : [...doc.querySelectorAll(selectors.cards)].filter(el => el.querySelector(selectors.text));
    // Prefer the smallest encompassing card when desktop/mobile selectors nest.
    return cards.filter(card => !cards.some(other => other !== card && card.contains(other)));
  }
  function readCard(card, pageURL, now = Date.now()) {
    const repostNode = card.querySelector(selectors.repost);
    const links = [...card.querySelectorAll('a[href]')].filter(a => !isInsideRepost(a, card));
    const priority = [...card.querySelectorAll(selectors.time), ...links].filter(a => !isInsideRepost(a, card) && !a.closest(selectors.text));
    let selected = null;
    let identity = null;
    for (const a of priority) {
      const parsed = permalink(a.getAttribute('href'), pageURL);
      if (parsed) { identity = parsed; selected = a; break; }
    }
    if (!identity) return null; // No fabricated IDs: unparsed card is visible in diagnostics.
    const uid = identity.uid || links.map(a => profileUid(a.getAttribute('href'))).find(Boolean) || '';
    if (!uid) return null;
    const contentNodes = [...card.querySelectorAll(selectors.text)].filter(n => !isInsideRepost(n, card));
    const content = contentNodes.find(n => !contentNodes.some(other => other !== n && n.contains(other))) || contentNodes[0];
    if (!content) return null;
    const authorNode = [...card.querySelectorAll(selectors.author)].find(n => !isInsideRepost(n, card));
    const timeNode = selected;
    const rawDate = timeNode?.getAttribute('datetime') || timeNode?.getAttribute('title') || timeNode?.querySelector('time')?.getAttribute('datetime') || normalizeSpace(timeNode?.textContent);
    const explicitTime = [...card.querySelectorAll('header time[datetime]')].find(n => !isInsideRepost(n, card))?.getAttribute('datetime');
    const dateRaw = rawDate || explicitTime || '';
    const createdAt = parseDate(dateRaw, now) || parseDate(explicitTime, now);
    const text = textOf(content, true);
    const repostText = textOf(repostNode?.querySelector('.wbpro-feed-reText') || repostNode);
    const repostLink = repostNode && [...repostNode.querySelectorAll('a[href]')].map(a => permalink(a.getAttribute('href'), pageURL)).find(Boolean);
    const hasExpand = [...card.querySelectorAll('a,button,span')].some(n => /^(展开全文|展开全部|展开)$/.test(normalizeSpace(n.textContent)) && n.children.length === 0);
    const images = [];
    const emoticons = emoticonsOf(content, pageURL);
    const imageNodes = [...card.querySelectorAll('img')];
    for (const img of imageNodes) {
      // Keep content media, never profile pictures, icons, stickers or emoji.
      const classText = `${img.className || ''} ${img.parentElement?.className || ''}`;
      if (/avatar|portrait|face|emoji|icon|headpic|logo/i.test(classText)) continue;
      if (img.closest('header, [class*="head_avatar"], .m-avatar-box, .WB_face')) continue;
      const candidate = img.getAttribute('data-original') || img.getAttribute('data-src') || img.currentSrc || img.getAttribute('src');
      const url = mediaURL(candidate);
      if (!url || /\/emoticon\/|\/oslarge\/|\/crop\.|\/square\/|\/50\/|\/180\//i.test(url)) continue;
      if (emoticons.some(item => item.url === url)) continue;
      const recognized = /sinaimg\.cn\//i.test(url) && /\/(?:large|mw\d+|orj\d+|bmiddle|thumb\d+|original|woriginal|wap\d+)\//i.test(url);
      const inMedia = img.closest('[class*="picture"], [class*="Picture"], [class*="media"], .weibo-media, .WB_media_wrap, [data-testid="post-images"]');
      if (!recognized && !inMedia) continue;
      if (!images.includes(url)) images.push(url);
    }
    return { id: identity.id, uid, author: textOf(authorNode) || uid, url: identity.url, createdAt, dateRaw, dateApproximate: /^(?:刚刚|\d+\s*(?:秒|分钟|小时)前)$/.test(dateRaw), text, images, emoticons, isRepost: Boolean(repostNode), repostDetectionVersion: 2, repostText, repostUrl: repostLink?.url || '', fullText: !hasExpand };
  }
  function restriction(doc, cardsCount) {
    const overlays = [...doc.querySelectorAll('[role="dialog"], .woo-modal-main, .m-toast, .m-alert')].map(n => normalizeSpace(n.textContent)).join(' ');
    const surface = overlays + ' ' + (cardsCount ? '' : normalizeSpace(doc.body?.textContent).slice(0, 12000));
    const patterns = [/访问频次过高/, /操作过于频繁/, /访问受限/, /账号异常/, /请完成.{0,8}验证/, /安全验证/, /验证码/, /登录后.{0,8}查看/, /请先登录/];
    return patterns.find(p => p.test(surface))?.source || '';
  }
  function scan(doc = document, pageURL = location.href, now = Date.now()) {
    const cards = cardElements(doc);
    const posts = [];
    let unparsed = 0;
    for (const card of cards) {
      try {
        const post = readCard(card, pageURL, now);
        if (post) posts.push(post); else unparsed++;
      } catch { unparsed++; }
    }
    const pageName = profileUid(pageURL) ? normalizeSpace(doc.title).replace(/的微博(?:[ _-]*微博)?$|\s*[-–—_]\s*微博$|^微博$/, '').trim() : '';
    return { ok: true, posts, diagnostics: { cards: cards.length, unparsed, restricted: restriction(doc, cards.length), url: pageURL, pageUid: profileUid(pageURL), pageName, identityPolicy:'纯数字帖子链接无法确认是否为永久链接 ID，计入未解析而不猜测转换' } };
  }
  function expand(doc = document) {
    let count = 0;
    for (const card of cardElements(doc)) {
      for (const element of card.querySelectorAll('a,button,span')) {
        const label = normalizeSpace(element.textContent);
        if (!/^(展开全文|展开全部|展开)$/.test(label) || element.children.length || count >= 15) continue;
        if (label === '展开' && !element.matches('.expand')) continue;
        if (element.closest('[class*="comment"], [class*="Comment"]') && !element.closest(selectors.repost)) continue;
        const href = element.getAttribute('href');
        // Never follow a detail-page link. Only trigger in-place expansion.
        if (href && href !== '#' && !/^javascript:\s*(?:void\(0\)|;?)$/i.test(href)) continue;
        element.click(); count++;
      }
    }
    return { ok: true, count };
  }
  function scroll(win = window, doc = document) {
    const root = doc.scrollingElement || doc.documentElement;
    win.scrollBy({ top: Math.max(250, Math.floor(win.innerHeight * 0.8)), behavior: 'instant' });
    return { ok: true, atBottom: root.scrollTop + win.innerHeight >= root.scrollHeight - 8 };
  }
  const adapter = { normalizeSpace, safeURL, mediaURL, permalink, profileUid, parseDate, textOf, emoticonsOf, cardElements, readCard, scan, expand, scroll };
  globalThis.WOBAdapter = adapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = adapter;
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!['WOB_SCAN', 'WOB_EXPAND', 'WOB_SCROLL'].includes(message?.type)) return false;
      try {
        sendResponse(message.type === 'WOB_SCAN' ? scan() : message.type === 'WOB_EXPAND' ? expand() : scroll());
      } catch (error) { sendResponse({ ok: false, error: String(error?.message || error) }); }
      return false;
    });
  }
})();
