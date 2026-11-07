import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const uid = '1000000001', other = '1000000002', profileURL = `https://weibo.com/u/${uid}`;
const avatar = 'https://tvax1.sinaimg.cn/crop.0.0.100.100.180/synthetic-avatar.jpg';
const photo = 'https://wx1.sinaimg.cn/large/synthetic-post-photo.jpg';
const card = (owner = uid, address = avatar) => `<article><header>
  <a href="/u/${owner}"><img class="woo-avatar-img" usercard="${owner}" src="${address}"></a>
  <a usercard="${owner}" href="/u/${owner}">合成作者</a>
  <a class="_time_test" href="/${owner}/AvatarTest1" title="2026-11-01 10:00">时间</a>
  </header><div data-testid="post-text">合成正文</div><div class="picture"><img src="${photo}"></div></article>`;
const vueHeader = (address = avatar, attributes = '') => `<div class="woo-panel-main _panel_synthetic_12" ${attributes}>
  <div class="_header_synthetic_24"><div class="woo-avatar-main _avatar2_synthetic_36">
  <img class="woo-avatar-img" data-src="false" src="${address}"></div><div>合成主页账号</div></div></div>`;

async function withPage(run) {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().isNavigationRequest() && route.request().url() === profileURL
      ? route.fulfill({contentType:'text/html; charset=utf-8', body:'<!doctype html><meta charset="utf-8"><title>合成主页账号的微博</title><body></body>'})
      : route.abort());
    await page.goto(profileURL);
    await page.evaluate(() => {
      globalThis.chrome ||= {};
      chrome.runtime = {onMessage:{addListener(listener) { globalThis.adapterMessageListener = listener; }}};
    });
    await page.addScriptTag({content: source});
    await run(page);
  } finally { await browser.close(); }
}

const scan = (page, html, url = profileURL) => page.evaluate(({html, url}) => {
  document.body.innerHTML = html;
  return WOBAdapter.scan(document, url, Date.parse('2026-11-01T09:00:00Z'));
}, {html, url});

test('profile avatar is preferred to feed avatars, normalizes its CDN URL and remains separate from post photos', async () => {
  await withPage(async page => {
    const preferred = 'http://tvax2.sinaimg.cn/crop.0.0.80.80.180/synthetic-header.jpg?version=2#fragment';
    const result = await scan(page, card() + `<div class="ProfileHeader_main_test" data-uid="${uid}">
      <div class="ProfileHeader_cover_test"><img src="${photo}"></div>
      <div class="ProfileHeader_avatar_test"><img class="woo-avatar-img" data-src="${preferred}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=="></div>
      </div>`);
    assert.equal(result.diagnostics.pageAvatar, preferred.replace('http:', 'https:').replace('#fragment', ''));
    assert.deepEqual(result.posts[0].images, [photo]);
    const legacy = await scan(page, `<div class="PCD_header"><div class="pf_photo"><img src="//tvax1.sinaimg.cn/crop.0.0.80.80.180/synthetic-legacy.jpg"></div></div>`);
    assert.equal(legacy.diagnostics.pageAvatar, 'https://tvax1.sinaimg.cn/crop.0.0.80.80.180/synthetic-legacy.jpg');
  });
});

test('author fallback rejects unrelated profiles, navigation, recommendations, comments and quoted avatars', async () => {
  await withPage(async page => {
    const attributed = `<a href="/u/${uid}"><img class="woo-avatar-img" src="${avatar}"></a>`;
    const excluded = `<nav>${attributed}</nav><aside>${card()}</aside><div class="Recommend_users">${card()}</div>
      <div class="Comment_list">${card()}</div><div class="retweet">${card()}</div>`;
    const conflicting = `<div class="ProfileHeader_main_test" data-uid="${other}"><div class="ProfileHeader_avatar_test">${attributed}</div></div>`;
    assert.equal((await scan(page, excluded + conflicting + card(other))).diagnostics.pageAvatar, '');
    const own = card().replace(`<a href="/u/${uid}"><img class="woo-avatar-img" usercard="${uid}" src="${avatar}"></a>`, `<img class="avatar" src="${avatar}">`);
    assert.equal((await scan(page, excluded + conflicting + card(other) + own)).diagnostics.pageAvatar, avatar);
    const wrongAvatar = card().replace(`usercard="${uid}" src=`, `usercard="${other}" src=`);
    assert.equal((await scan(page, wrongAvatar)).diagnostics.pageAvatar, '');
    assert.equal((await scan(page, `<article><div data-testid="post-text">${attributed}</div></article>`)).diagnostics.pageAvatar, '');
  });
});

test('profile avatars reject unsafe or off-CDN sources and do not infer an account from a non-numeric page', async () => {
  await withPage(async page => {
    const invalid = ['https://example.test/avatar.jpg', 'https://sinaimg.cn.evil.test/avatar.jpg',
      'https://user:pass@tvax1.sinaimg.cn/a.jpg', 'https://tvax1.sinaimg.cn:8443/a.jpg',
      'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'file:///avatar.jpg',
      'https://tvax1.sinaimg.cn\\evil.jpg', 'https://face.t.sinajs.cn/avatar.jpg'];
    for (const address of invalid) {
      const result = await scan(page, `<div class="ProfileHeader_avatar_test"><img class="woo-avatar-img" src="${address}"></div>`);
      assert.equal(result.diagnostics.pageAvatar, '', address);
    }
    for (const url of ['https://weibo.com/', 'https://weibo.com/n/example', 'https://example.test/u/1000000001']) {
      assert.equal((await scan(page, card(), url)).diagnostics.pageAvatar, '');
    }
  });
});

test('hashed Vue profile avatars work without posts or usercard and preserve signed queries after a false lazy source', async () => {
  await withPage(async page => {
    const signed = 'https://tvax2.sinaimg.cn/crop.0.0.500.500.1024/synthetic-signed.jpg?KID=imgbed,tva&Expires=1799999999&ssig=synthetic%2Bsignature';
    const result = await scan(page, vueHeader(signed));
    assert.equal(result.posts.length, 0);
    assert.equal(result.diagnostics.pageAvatar, signed);
    assert.equal(result.diagnostics.pageUid, uid);
    assert.equal(result.diagnostics.pageName, '合成主页账号');
    // 本人作者栏也使用 data-src="false"，无效占位不能遮挡有效 src。
    const author = card(uid, signed).replace('class="woo-avatar-img"', 'class="woo-avatar-img" data-src="false"');
    assert.equal((await scan(page, author)).diagnostics.pageAvatar, signed);
  });
});

test('hashed Vue profile candidates reject unrelated areas, conflicting owners and ambiguous headers', async () => {
  await withPage(async page => {
    const wrappers = ['nav', 'aside', 'article'];
    for (const tag of wrappers) assert.equal((await scan(page, `<${tag}>${vueHeader()}</${tag}>`)).diagnostics.pageAvatar, '', tag);
    for (const attributes of ['role="navigation"', 'role="complementary"', 'class="Recommend_users"', 'class="Comment_list"',
      'class="reply-list"', 'class="retweet"', 'hidden', 'aria-hidden="true"', `data-uid="${other}"`, `usercard="${other}"`]) {
      assert.equal((await scan(page, `<div ${attributes}>${vueHeader()}</div>`)).diagnostics.pageAvatar, '', attributes);
    }
    const second = 'https://tvax2.sinaimg.cn/crop.0.0.80.80.180/synthetic-other.jpg';
    assert.equal((await scan(page, vueHeader() + vueHeader(second))).diagnostics.pageAvatar, '');
    assert.equal((await scan(page, vueHeader() + vueHeader(second) + card())).diagnostics.pageAvatar, avatar);
    assert.equal((await scan(page, vueHeader().replace('_avatar2_synthetic_36', '_avatar_synthetic_36'))).diagnostics.pageAvatar, '');
    assert.equal((await scan(page, vueHeader().replace('woo-panel-main', 'unrelated-panel'))).diagnostics.pageAvatar, '');
    assert.equal((await scan(page, vueHeader(), 'https://weibo.com/')).diagnostics.pageAvatar, '');
  });
});

test('read-only profile messages see later avatar mounts without parsing, expanding or scrolling posts', async () => {
  await withPage(async page => {
    const initial = await page.evaluate(() => {
      let response;
      adapterMessageListener({type:'WOB_PROFILE'}, {}, value => { response = value; });
      return response;
    });
    assert.deepEqual(initial, {ok:true, diagnostics:{pageUid:uid, pageName:'合成主页账号', pageAvatar:'', restricted:''}});
    await page.evaluate(html => {
      document.body.innerHTML = html + '<article><button>展开全文</button><div data-testid="post-text">不能读取此正文</div></article>';
      document.querySelector('button').onclick = () => { throw new Error('profile must not expand'); };
      window.scrollBy = () => { throw new Error('profile must not scroll'); };
      Object.defineProperty(document.querySelector('[data-testid="post-text"]'), 'textContent', {
        get() { throw new Error('profile must not parse posts'); }
      });
    }, vueHeader());
    const mounted = await page.evaluate(() => {
      let response;
      const returned = adapterMessageListener({type:'WOB_PROFILE'}, {}, value => { response = value; });
      return {response, returned};
    });
    assert.equal(mounted.returned, false);
    assert.deepEqual(mounted.response, {ok:true, diagnostics:{pageUid:uid, pageName:'合成主页账号', pageAvatar:avatar, restricted:''}});
    const restricted = await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog">请完成安全验证</div>');
      let response;
      adapterMessageListener({type:'WOB_PROFILE'}, {}, value => { response = value; });
      return response;
    });
    assert.ok(restricted.diagnostics.restricted);
  });
});
