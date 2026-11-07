import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const avatarA = 'https://tvax1.sinaimg.cn/crop.0.0.96.96.180/synthetic-account-a.jpg';
const avatarB = 'https://tvax2.sinaimg.cn/crop.0.0.96.96.180/synthetic-account-b.jpg';
const avatarSlow = 'https://tvax1.sinaimg.cn/crop.0.0.96.96.180/synthetic-account-slow.jpg';
const avatarBroken = 'https://tvax1.sinaimg.cn/crop.0.0.96.96.180/synthetic-account-broken.jpg';
const avatarImage = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#50847a"/><circle cx="48" cy="34" r="17" fill="#ffe5c4"/><path d="M17 96V79a31 31 0 0 1 62 0v17" fill="#d8e9e5"/><path d="M30 31c0-24 39-25 37 4-8-4-14-13-16-15-5 7-13 11-21 11" fill="#36485a"/></svg>';

async function startPreview() {
  const source = readFileSync(new URL('../scripts/preview.mjs', import.meta.url), 'utf8')
    .replace("const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));", `const root = ${JSON.stringify(projectRoot)};`)
    .replace("server.listen(4178,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4178'));",
      "server.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));");
  assert.ok(source.includes('server.listen(0,'), 'preview must use an isolated random port');
  const child = spawn(process.execPath, ['--input-type=module'], {cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Preview failed to start: ${output}`)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited (${code}): ${output}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Local: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', data => { output += data; });
  });
  child.stdin.end(source);
  try { return {origin: await ready, close: () => child.kill()}; }
  catch (error) { child.kill(); throw error; }
}

async function openPanel(browser, origin, {slowRequest = null, beforePanel = null} = {}) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), requests = [], errors = [];
  let preparedPanel = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (new URL(url).origin === origin) {
      // 在真实浮窗第一次载入前设置资料响应和旧缓存，首次连接仍由生产代码完成。
      if (beforePanel && !preparedPanel && new URL(url).pathname === '/floating-panel.js') {
        preparedPanel = true;
        await beforePanel(page);
      }
      return route.continue();
    }
    requests.push({url, referer: request.headers().referer || ''});
    // 所有头像均由本机合成素材返回，其余远程请求一律拒绝，不访问新浪 CDN。
    if ([avatarA, avatarB].includes(url)) return route.fulfill({contentType:'image/svg+xml', body:avatarImage});
    if (url === avatarBroken) return route.fulfill({contentType:'image/png', body:'synthetic invalid image'});
    if (url === avatarSlow && slowRequest) return slowRequest(route);
    return route.abort();
  });
  await page.goto(origin);
  const handle = await page.locator('#weibo-obsidian-floating-panel iframe').elementHandle();
  const panel = await handle.contentFrame();
  assert.ok(panel, 'the actual floating dashboard must load');
  await panel.waitForFunction(() => !document.getElementById('wizardNext').disabled && !document.getElementById('backupPanel').inert);
  return {page, panel, requests, errors};
}

async function identify(page, panel, {uid, avatar = '', name = '合成头像账号'}) {
  await page.evaluate(({uid, avatar, name}) => {
    window.avatarScanBase ||= previewAPI.scan;
    previewState.connected = true;
    previewAPI.profileURL = () => previewState.connected ? `https://weibo.com/u/${uid}` : 'https://weibo.com/';
    previewAPI.scan = () => {
      const original = window.avatarScanBase();
      return {...original, posts:[], diagnostics:{...original.diagnostics, pageUid:uid, pageName:name, pageAvatar:avatar}};
    };
  }, {uid, avatar, name});
  // 重用生产重新识别处理函数；已连接时按钮只是隐藏，未替换账号业务逻辑。
  await panel.evaluate(() => document.getElementById('connect').click());
  await panel.waitForFunction(async uid => {
    const target = await (await import('/db.js')).get('settings','target');
    return target?.uid === uid && document.getElementById('accountUid').textContent.includes(uid);
  }, uid);
}

async function expectAvatar(panel, url) {
  await panel.waitForFunction(url => {
    const image = document.getElementById('accountAvatar');
    return image && !image.hidden && image.naturalWidth > 0 && image.currentSrc === url;
  }, url);
  assert.equal(await panel.locator('#accountAvatarFallback').isHidden(), true);
}

async function expectFallback(panel) {
  await panel.waitForFunction(() => document.getElementById('accountAvatar').hidden && getComputedStyle(document.getElementById('accountAvatarFallback')).display !== 'none');
  assert.equal(await panel.locator('#accountAvatarFallback').isVisible(), true);
}

test('the target avatar is displayed without a referrer and restored from local account metadata', {timeout:60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined, headless:true});
    const {page, panel, requests, errors} = await openPanel(browser, preview.origin);
    const uid = '1000000041';
    await identify(page, panel, {uid, avatar:avatarA.replace('https:', ''), name:'山色手记'});
    await expectAvatar(panel, avatarA);
    assert.equal(await panel.locator('#accountAvatar').getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await panel.locator('#accountName').textContent(), '山色手记');
    const target = await panel.evaluate(async () => (await import('/db.js')).get('settings','target'));
    assert.equal(target.avatar, avatarA);
    assert.equal(target.uid, uid);
    assert.ok(requests.some(request => request.url === avatarA));
    assert.ok(requests.every(request => request.referer === ''), 'avatar requests must not expose the source page');
    if (process.env.AVATAR_SCREENSHOT) await panel.locator('#backupPanel').screenshot({path:process.env.AVATAR_SCREENSHOT});

    await page.evaluate(() => {previewState.connected = false;});
    await panel.evaluate(() => location.reload());
    await panel.waitForFunction(() => document.getElementById('accountUid')?.textContent.includes('本机已有记录'));
    await expectAvatar(panel, avatarA);
    assert.equal(await panel.locator('#accountName').textContent(), '山色手记');
    assert.equal(await panel.locator('#wizardNext').isDisabled(), true);
    assert.equal(await panel.locator('#connect').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});

test('avatar failures and account changes cannot leave another account photo or request unsafe URLs', {timeout:60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser, releaseSlow;
  const slowGate = new Promise(resolve => {releaseSlow = resolve;});
  let reachedSlow;
  const slowStarted = new Promise(resolve => {reachedSlow = resolve;});
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined, headless:true});
    const {page, panel, requests, errors} = await openPanel(browser, preview.origin, {slowRequest:async route => {
      reachedSlow();
      await slowGate;
      try {await route.fulfill({contentType:'image/svg+xml', body:avatarImage});} catch {/* 账号切换取消旧请求是预期结果。 */}
    }});
    await identify(page, panel, {uid:'1000000042', avatar:avatarA});
    await expectAvatar(panel, avatarA);
    await identify(page, panel, {uid:'1000000043'});
    await expectFallback(panel);
    assert.equal(await panel.locator('#accountAvatar').getAttribute('src'), null);

    await identify(page, panel, {uid:'1000000044', avatar:avatarBroken});
    await expectFallback(panel);
    await panel.waitForFunction(() => !document.getElementById('accountAvatar').getAttribute('src'));
    for (const [index, avatar] of [
      'https://sinaimg.cn.evil.test/avatar.png',
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      'https://user:secret@tvax1.sinaimg.cn/avatar.jpg',
    ].entries()) {
      const before = requests.length;
      await identify(page, panel, {uid:String(1000000050 + index), avatar});
      await expectFallback(panel);
      await page.waitForTimeout(100);
      assert.equal(requests.length, before, 'unsafe avatars must be rejected before a request is made');
      assert.equal(await panel.locator('#accountAvatar').getAttribute('src'), null);
    }

    await identify(page, panel, {uid:'1000000061', avatar:avatarSlow, name:'旧账号'});
    await slowStarted;
    await panel.evaluate(() => {window.staleAvatarElement = document.getElementById('accountAvatar');});
    await identify(page, panel, {uid:'1000000062', avatar:avatarB, name:'新账号'});
    await expectAvatar(panel, avatarB);
    releaseSlow();
    await panel.evaluate(async () => {await window.staleAvatarElement.decode().catch(() => {}); await new Promise(requestAnimationFrame);});
    await expectAvatar(panel, avatarB);
    assert.equal(await panel.locator('#accountName').textContent(), '新账号');
    assert.ok(requests.every(request => [avatarA,avatarB,avatarSlow,avatarBroken].includes(request.url)));
    assert.deepEqual(errors, []);
  } finally {
    releaseSlow();
    if (browser) await browser.close();
    preview.close();
  }
});

test('a late profile avatar replaces an empty or cached avatar without collection or manual identification', {timeout:60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined, headless:true});
    for (const cachedAvatar of ['', avatarA]) {
      const {page, panel, requests, errors} = await openPanel(browser, preview.origin, {beforePanel:async page => {
        await page.evaluate(async cachedAvatar => {
          if (cachedAvatar) {
            const db = await import('/db.js');
            await db.put('settings', {uid:'1000000002', name:'旧的合成资料', avatar:cachedAvatar,
              url:'https://weibo.com/u/1000000002', connectedAt:'2020-01-01T00:00:00.000Z'}, 'target');
          }
          const scan = previewAPI.scan;
          window.lateAvatarReady = false;
          previewAPI.scan = () => {
            const result = scan();
            return {...result, diagnostics:{...result.diagnostics, pageName:'延迟资料账号',
              pageAvatar:window.lateAvatarReady ? 'https://tvax2.sinaimg.cn/crop.0.0.96.96.180/synthetic-account-b.jpg' : ''}};
          };
        }, cachedAvatar);
      }});
      if (cachedAvatar) await expectAvatar(panel, cachedAvatar);
      else await expectFallback(panel);
      const before = await panel.evaluate(async () => (await import('/db.js')).get('settings','target'));
      assert.equal(before.avatar, cachedAvatar);
      assert.equal(before.uid, '1000000002');
      await panel.evaluate(() => {
        const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
        window.avatarRecoveryMessages = [];
        chrome.tabs.sendMessage = (tabId, message, ...args) => {
          window.avatarRecoveryMessages.push(message.type);
          return sendMessage(tabId, message, ...args);
        };
      });
      // 只改变已挂载的页面资料，不点击开始、继续或重新识别。
      await page.evaluate(() => {window.lateAvatarReady = true;});
      await expectAvatar(panel, avatarB);
      await panel.waitForFunction(async avatar => (await (await import('/db.js')).get('settings','target'))?.avatar === avatar, avatarB);
      const after = await panel.evaluate(async () => ({
        target:await (await import('/db.js')).get('settings','target'),
        posts:await (await import('/db.js')).all('posts'), messages:window.avatarRecoveryMessages,
      }));
      assert.deepEqual(after.target, {...before, avatar:avatarB}, 'avatar recovery preserves all other target metadata');
      assert.ok(after.messages.includes('WOB_PROFILE'), 'the production profile-only recovery must run');
      assert.ok(after.messages.every(type => type === 'WOB_PROFILE'), 'recovery must not collect, expand or scroll');
      assert.equal(after.posts.length, 0);
      assert.equal(await panel.locator('#stepNumber').textContent(), '01 / 04');
      assert.equal(await panel.locator('#accountName').textContent(), '延迟资料账号');
      assert.equal(await panel.locator('#wizardNext').isEnabled(), true);
      assert.ok(requests.every(request => [avatarA, avatarB].includes(request.url) && request.referer === ''));
      assert.deepEqual(errors, []);
      if (process.env.AVATAR_SCREENSHOT) await panel.locator('#backupPanel').screenshot({path:process.env.AVATAR_SCREENSHOT});
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});

test('avatar metadata updates are atomic and cannot overwrite a different target account', {timeout:60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined, headless:true});
    const {panel, errors} = await openPanel(browser, preview.origin);
    const result = await panel.evaluate(async ({avatarA, avatarB, avatarSlow}) => {
      const db = await import('/db.js');
      const first = {uid:'1000000071', name:'事务账号甲', avatar:avatarA, url:'https://weibo.com/u/1000000071',
        connectedAt:'2026-01-01T00:00:00.000Z', metadata:{note:'须保留的合成字段', sequence:71}};
      const second = {uid:'1000000072', name:'事务账号乙', avatar:avatarB, url:'https://weibo.com/u/1000000072',
        connectedAt:'2026-02-01T00:00:00.000Z', metadata:{note:'另一个浮窗的新账号', sequence:72}};
      await db.put('settings', first, 'target');
      const changed = await db.saveTargetAvatar(first.uid, avatarB);
      const updated = await db.get('settings','target');
      // 先启动旧头像更新，再并发切换账号；分离的 get/put 实现会在新账号之后写回旧账号。
      await db.put('settings', first, 'target');
      await Promise.all([db.saveTargetAvatar(first.uid, avatarSlow), db.put('settings', second, 'target')]);
      const afterRace = await db.get('settings','target');
      const staleChanged = await db.saveTargetAvatar(first.uid, avatarA);
      const afterStale = await db.get('settings','target');
      await db.remove('settings','target');
      const missingChanged = await db.saveTargetAvatar(first.uid, avatarA);
      const afterMissing = await db.get('settings','target');
      return {first, second, changed, updated, afterRace, staleChanged, afterStale, missingChanged, afterMissing};
    }, {avatarA, avatarB, avatarSlow});
    assert.equal(result.changed, true);
    assert.deepEqual(result.updated, {...result.first, avatar:avatarB});
    assert.deepEqual(result.afterRace, result.second, 'a concurrent account switch must keep the new account intact');
    assert.equal(result.staleChanged, false);
    assert.deepEqual(result.afterStale, result.second);
    assert.equal(result.missingChanged, false);
    assert.equal(result.afterMissing, undefined);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});
