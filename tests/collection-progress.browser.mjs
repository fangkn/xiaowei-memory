import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

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

async function openPanel(browser, origin) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  // 仅缩短采集器的等待时间，采集、去重、状态转换和 DOM 渲染均运行生产代码。
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.collectionWait = 30;
    window.setTimeout = (callback, delay, ...args) => schedule(callback,
      delay >= 2500 && delay < 3200 ? window.collectionWait : delay, ...args);
  });
  await page.goto(origin);
  const handle = await page.locator('#weibo-obsidian-floating-panel iframe').elementHandle();
  const panel = await handle.contentFrame();
  assert.ok(panel, 'the actual floating dashboard must load');
  await panel.locator('#wizardNext').click();
  return {page, panel};
}

test('a finished page collection fills its bar while resume, manual pause and errors retain distinct states', {timeout: 60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
    const {page, panel} = await openPanel(browser, preview.origin);
    await panel.locator('#wizardStart').click();
    await panel.waitForFunction(() => document.getElementById('pageProgress').dataset.state === 'ready');
    assert.equal(await panel.locator('#stepTitle').textContent(), '可以导出了');
    assert.match(await panel.locator('#progressSummary').textContent(), /本轮采集已结束/);
    assert.equal(await panel.locator('#collectedCount').textContent(), '2');
    assert.equal(await panel.locator('#wizardToExport').isEnabled(), true);
    const ready = await panel.locator('#pageProgress').evaluate(element => {
      const style = getComputedStyle(element, '::after');
      return {width: element.getBoundingClientRect().width, filled: parseFloat(style.width),
        animation: style.animationName, transform: style.transform, hidden: element.hidden,
        now: element.getAttribute('aria-valuenow'), max: element.getAttribute('aria-valuemax'),
        description: element.getAttribute('aria-valuetext')};
    });
    assert.equal(ready.hidden, false);
    assert.ok(Math.abs(ready.filled - ready.width) < 1, 'finished bar must cover the whole track');
    assert.equal(ready.animation, 'none');
    assert.equal(ready.transform, 'none');
    assert.equal(ready.now, '1');
    assert.equal(ready.max, '1');
    assert.match(ready.description, /本轮|已保存/);
    if (process.env.PROGRESS_SCREENSHOT) await panel.locator('#backupPanel').screenshot({path: process.env.PROGRESS_SCREENSHOT});

    // 从满条状态继续采集，必须回到未知总量的工作态，不能沿用完成值。
    await panel.evaluate(() => { window.collectionWait = 500; });
    await panel.locator('#wizardResume').click();
    await panel.waitForFunction(() => document.getElementById('pageProgress').dataset.state === 'working');
    assert.equal(await panel.locator('#pageProgress').getAttribute('aria-valuenow'), null);
    await panel.locator('#pause').click();
    await panel.waitForFunction(() => document.getElementById('stepTitle').textContent === '采集已暂停');
    assert.equal(await panel.locator('#pageProgress').isHidden(), true);
    assert.equal(await panel.locator('#wizardToExport').isEnabled(), true);

    // 下一次连接仍成功，仅让真正的采集请求失败，避免把异常误报为完成。
    await page.evaluate(() => {
      const scan = previewAPI.scan;
      let calls = 0;
      previewAPI.scan = () => ++calls === 1 ? scan() : {ok: false, error: '合成采集故障'};
    });
    await panel.locator('#wizardResume').click();
    await panel.waitForFunction(() => document.getElementById('stepTitle').textContent === '采集已中断');
    assert.equal(await panel.locator('#pageProgress').isHidden(), true);
    assert.equal(await panel.locator('#pageProgress').getAttribute('aria-valuenow'), null);
    assert.match(await panel.locator('#progressSummary').textContent(), /采集已中断.*页面读取失败/);
    assert.equal(await panel.locator('#collectedCount').textContent(), '2');
    assert.equal(await panel.locator('#wizardToExport').isEnabled(), true);
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});

test('an empty page collection does not show a completed bar or offer an empty export', {timeout: 60000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
    const {page, panel} = await openPanel(browser, preview.origin);
    await page.evaluate(() => {
      const scan = previewAPI.scan;
      previewAPI.scan = () => ({...scan(), posts: []});
    });
    await panel.locator('#pageOptions summary').click();
    await panel.locator('#scroll').uncheck();
    await panel.locator('#wizardStart').click();
    await panel.waitForFunction(() => document.getElementById('stepTitle').textContent === '暂未找到微博');
    assert.equal(await panel.locator('#collectedCount').textContent(), '0');
    assert.equal(await panel.locator('#pageProgress').isHidden(), true);
    assert.equal(await panel.locator('#pageProgress').getAttribute('aria-valuenow'), null);
    assert.equal(await panel.locator('#wizardToExport').isDisabled(), true);
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});
