import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');

test('real DOM preserves readable emoji labels, sources and photos across page and API HTML collectors', async () => {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    const html = '旅行<img class="emoji" alt="[笑cry]" src="//h5.sinaimg.cn/m/emoticon/laugh.png">' +
      '<img alt="[抱抱&amp;爱]" src="https://h5.sinaimg.cn/m/emoticon/hug.png">' +
      '<img class="emoji" alt="[旧表情]" src="https://face.t.sinajs.cn/emoji.gif">' +
      '<img class="emoji" alt="[不可信]" src="https://sinaimg.cn.evil.test/emoji.gif">';
    await page.setContent(`<article><header><a usercard="1000000001" href="/u/1000000001">测试</a>` +
      `<a class="_time_a" href="/1000000001/Rtest12" title="2026-11-01 12:00">今天</a></header>` +
      `<div data-testid="post-text">${html}</div><div data-testid="post-images"><img src="https://wx1.sinaimg.cn/large/photo.jpg"></div></article>`);
    await page.addScriptTag({content:source('content.js')});
    await page.addScriptTag({content:source('media-data.js').replace(/^export /gm,'')});
    await page.addScriptTag({content:source('history-bridge.js').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')});
    const result = await page.evaluate(html => ({post:WOBAdapter.scan(document,'https://weibo.com/u/1000000001').posts[0],
      text:htmlToText(html),emoticons:htmlToEmoticons(html)}), html);
    const expected = [{text:'[笑cry]',url:'https://h5.sinaimg.cn/m/emoticon/laugh.png'},
      {text:'[抱抱&爱]',url:'https://h5.sinaimg.cn/m/emoticon/hug.png'},
      {text:'[旧表情]',url:'https://face.t.sinajs.cn/emoji.gif'}];
    assert.equal(result.post.text,'旅行[笑cry][抱抱&爱][旧表情][不可信]');
    assert.equal(result.text,result.post.text);
    assert.deepEqual(result.emoticons,expected);
    assert.deepEqual(result.post.emoticons,expected);
    assert.deepEqual(result.post.images,['https://wx1.sinaimg.cn/large/photo.jpg']);
  } finally { await browser.close(); }
});
