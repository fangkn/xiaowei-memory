import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const sandbox = { URL, Date, module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { safeURL, permalink, profileUid, parseDate } = sandbox.module.exports;
const now = Date.parse('2026-11-01T09:00:00Z');

const modern = `<!doctype html><body><main id="scroller">
<article class="woo-panel-main _wrap_ecgcn_2">
<header><a usercard="1000000001" href="//weibo.com/u/1000000001">示例作者</a><img class="avatar" src="https://wx1.sinaimg.cn/large/avatar.jpg"><a class="_time_1tpft_33" href="https://weibo.com/1000000001/A1b2C3d4E" title="2026-11-01 17:14">2小时前</a></header>
<div class="wbpro-feed-content"><div class="wbpro-feed-ogText"><div class="_wbtext_xxx">第一行<br>第二行 <a href="https://weibo.com/topic">#话题#</a><span class="expand">展开</span></div></div><div class="picture"><img class="_focusImg_x" src="https://wx4.sinaimg.cn/orj360/photo.jpg"><img class="icon" src="https://wx4.sinaimg.cn/large/icon.jpg"></div></div>
<footer><i class="woo-font woo-font--retweet _retweetIcon_198pe_119"></i><span>转发</span></footer>
</article>
<article data-testid="weibo-post"><header><a usercard="1000000001" href="/u/1000000001">示例作者</a><a class="_time_a" href="/1000000001/B2c3D4e5F" title="2026-10-31 01:00">昨天</a></header><div data-testid="post-text">我的看法<br>保留</div><div class="retweet _retweet_x"><div class="wbpro-feed-reText"><a usercard="999999" href="/u/999999">@转发原作者</a><div class="_wbtext_x">原文内容<img alt="[允悲]" src="https://face.t.sinajs.cn/emoji.gif"></div></div><div class="picture"><img src="https://wx1.sinaimg.cn/large/repost.jpg"></div><div class="_retweetBar_x"><a class="_time_x" href="https://weibo.com/999999/Rzzzzzz" title="2026-10-28 14:00">10月28日</a> 评论 1 转发 2</div></div></article>
<article data-testid="weibo-post"><div data-testid="post-text">没有可靠 ID 的卡片</div></article>
</main></body>`;

test('realistic desktop DOM: own text, repost, image filtering, completeness and expansion', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(modern);
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(now => WOBAdapter.scan(document, 'https://weibo.com/u/1000000001', now), now);
    assert.equal(result.posts.length, 2);
    assert.equal(result.diagnostics.cards, 3);
    assert.equal(result.diagnostics.unparsed, 1);
    assert.equal(result.diagnostics.pageUid, '1000000001');
    assert.equal(result.posts[0].text, '第一行\n第二行 #话题# (https://weibo.com/topic)');
    assert.equal(result.posts[0].fullText, false);
    assert.equal(result.posts[0].isRepost, false);
    assert.equal(result.posts[0].repostDetectionVersion, 2);
    assert.equal(result.posts[0].createdAt, '2026-11-01T09:14:00.000Z');
    assert.deepEqual(result.posts[0].images, ['https://wx4.sinaimg.cn/orj360/photo.jpg']);
    assert.equal(result.posts[1].isRepost, true);
    assert.equal(result.posts[1].text, '我的看法\n保留');
    assert.ok(result.posts[1].repostText.includes('原文内容[允悲]'));
    assert.ok(!result.posts[1].repostText.includes('评论'));
    assert.equal(result.posts[1].repostUrl, 'https://weibo.com/999999/Rzzzzzz');
    await page.evaluate(() => {
      document.querySelector('.expand').onclick = e => {
        e.currentTarget.className = 'collapse';
        e.currentTarget.textContent = '收起';
        e.currentTarget.before(' 后续全文');
      };
    });
    assert.equal((await page.evaluate(() => WOBAdapter.expand())).count, 1);
    const after = await page.evaluate(now => WOBAdapter.scan(document, 'https://weibo.com/u/1000000001', now), now);
    assert.equal(after.posts[0].fullText, true);
    assert.ok(after.posts[0].text.includes('后续全文'));
    assert.ok(!after.posts[0].text.includes('收起'));
    // Words inside a normal post must not falsely flag a CAPTCHA gate.
    await page.evaluate(() => document.querySelector('[data-testid="post-text"]').textContent = '我正在讨论验证码和访问受限的体验');
    assert.equal((await page.evaluate(() => WOBAdapter.scan())).diagnostics.restricted, '');
    await page.evaluate(() => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.textContent = '请完成安全验证'; document.body.append(d); });
    assert.ok((await page.evaluate(() => WOBAdapter.scan())).diagnostics.restricted);
  } finally { await browser.close(); }
});

test('legacy mobile decimal identity is rejected rather than inventing canonical ID', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<div class="card-wrap"><div class="card"><a href="/u/1234567">作者</a><a href="https://m.weibo.cn/detail/12345678901234567">11-01</a><div class="weibo-text">正文<br>换行</div></div></div>');
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(() => WOBAdapter.scan(document, 'https://m.weibo.cn/u/1234567'));
    assert.equal(result.posts.length, 0);
    assert.equal(result.diagnostics.unparsed, 1);
  } finally { await browser.close(); }
});

test('own unknown date does not inherit nested repost timestamp',async()=>{
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<article><header><a usercard="1234567" href="/u/1234567">作者</a><a class="_time_x" href="/1234567/Rabcde1">11-01</a></header><div data-testid="post-text">我的评论</div><div class="retweet"><header><a href="/9999999/Rquoted">原作者</a><time datetime="2020-01-01T00:00:00Z">旧文</time></header><div class="wbpro-feed-reText"><div class="_wbtext_x">原文</div></div></div></article>');
    await page.addScriptTag({content:source});
    const result=await page.evaluate(()=>WOBAdapter.scan(document,'https://weibo.com/u/1234567'));
    assert.equal(result.posts.length,1);assert.equal(result.posts[0].createdAt,null);assert.equal(result.posts[0].dateRaw,'11-01');
  }finally{await browser.close()}
});
