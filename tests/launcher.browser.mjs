import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const origin = 'https://launcher.synthetic.test';
const files = new Map([
  ['/launcher.html', ['launcher.html', 'text/html']],
  ['/launcher.js', ['launcher.js', 'application/javascript']],
  ['/launcher.css', ['launcher.css', 'text/css']],
  ['/style.css', ['style.css', 'text/css']],
  ['/icons/logo.svg', ['icons/logo.svg', 'image/svg+xml']],
]);

async function startBrowser() {
  const {chromium} = require('playwright');
  return chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
}

async function openLauncher(browser, options = {}) {
  const page = await browser.newPage({viewport: {width: 300, height: 400}});
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = url.origin === origin ? files.get(url.pathname) : undefined;
    if (!file) {
      external.push(url.href);
      return route.abort();
    }
    return route.fulfill({contentType: file[1], body: readFileSync(new URL(`../extension/${file[0]}`, import.meta.url))});
  });
  await page.addInitScript(options => {
    window.launcherTestState = {tab: {id: 42, url: 'chrome://extensions/'}, ...options};
    window.launcherTestCalls = {queries: [], injections: [], created: [], closed: 0};
    const state = window.launcherTestState, calls = window.launcherTestCalls;
    window.close = () => { calls.closed++; };
    Object.defineProperty(window, 'chrome', {configurable: true, value: {
      tabs: {
        query: async query => {
          calls.queries.push(query);
          return state.tab ? [state.tab] : [];
        },
        create: async properties => {
          calls.created.push(properties);
          if (state.failCreate) throw new Error('Synthetic tab creation failure');
          return {id: 73};
        },
      },
      action: {setBadgeText: async () => {}, setTitle: async () => {}},
      scripting: {executeScript: async properties => {
        calls.injections.push(properties);
        if (state.failInjection) throw new Error('Synthetic injection failure');
        return [{frameId: 0}];
      }},
    }});
  }, options);
  await page.goto(`${origin}/launcher.html`);
  await page.waitForFunction(() => !document.getElementById('openWeibo').disabled);
  return {page, errors, external};
}

test('the real launcher renders compact offline guidance and navigates only after the visible button is pressed', {timeout: 30000}, async () => {
  const browser = await startBrowser();
  try {
    const {page, errors, external} = await openLauncher(browser);
    assert.equal(await page.getByRole('heading', {name: '先打开微博个人主页'}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: '打开微博', exact: true}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: '重试打开', exact: true}).isHidden(), true);
    const before = await page.evaluate(() => ({
      calls: launcherTestCalls,
      width: document.body.getBoundingClientRect().width,
      height: document.body.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      status: document.querySelector('[role="status"]').getAttribute('aria-live'),
    }));
    assert.deepEqual(before.calls.injections, []);
    assert.deepEqual(before.calls.created, []);
    assert.equal(before.calls.closed, 0);
    assert.ok(before.width >= 280 && before.width <= 340, 'guidance must remain compact');
    assert.ok(before.height <= 320, 'guidance must not become a full dashboard');
    assert.equal(before.overflow, false);
    assert.equal(before.status, 'polite');
    if (process.env.LAUNCHER_SCREENSHOT) await page.locator('body').screenshot({path: process.env.LAUNCHER_SCREENSHOT});
    await page.getByRole('button', {name: '打开微博', exact: true}).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => launcherTestCalls.closed === 1);
    assert.deepEqual(await page.evaluate(() => launcherTestCalls.created), [{url: 'https://weibo.com/', active: true}]);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'all fixtures must stay offline');
  } finally { await browser.close(); }
});

test('the real launcher shows an injection error and recovers on the current Weibo tab', {timeout: 30000}, async () => {
  const browser = await startBrowser();
  try {
    const {page, errors, external} = await openLauncher(browser, {
      tab: {id: 42, url: 'https://weibo.com/u/1000000001'}, failInjection: true,
    });
    assert.equal(await page.getByRole('heading', {name: '面板暂时未能打开'}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: '重试打开', exact: true}).isVisible(), true);
    assert.doesNotMatch(await page.locator('body').innerText(), /Synthetic|Error:/);
    assert.equal(await page.evaluate(() => launcherTestCalls.closed), 0);
    await page.evaluate(() => {
      launcherTestState.failInjection = false;
      launcherTestState.tab = {id: 84, url: 'https://www.weibo.com/'};
    });
    await page.getByRole('button', {name: '重试打开', exact: true}).click();
    await page.waitForFunction(() => launcherTestCalls.closed === 1);
    const calls = await page.evaluate(() => launcherTestCalls);
    assert.equal(calls.queries.length, 2);
    assert.deepEqual(calls.injections.at(-1), {target: {tabId: 84, frameIds: [0]}, files: ['floating-panel.js']});
    assert.deepEqual(calls.created, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally { await browser.close(); }
});

test('a failed explicit navigation leaves the real launcher open with a working retry button', {timeout: 30000}, async () => {
  const browser = await startBrowser();
  try {
    const {page, errors, external} = await openLauncher(browser, {failCreate: true});
    await page.getByRole('button', {name: '打开微博', exact: true}).click();
    assert.equal(await page.getByRole('heading', {name: '暂时无法打开微博'}).isVisible(), true);
    assert.equal(await page.getByRole('button', {name: '打开微博', exact: true}).isEnabled(), true);
    assert.equal(await page.evaluate(() => launcherTestCalls.closed), 0);
    await page.evaluate(() => { launcherTestState.failCreate = false; });
    await page.getByRole('button', {name: '打开微博', exact: true}).click();
    await page.waitForFunction(() => launcherTestCalls.closed === 1);
    assert.equal(await page.evaluate(() => launcherTestCalls.created.length), 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally { await browser.close(); }
});
