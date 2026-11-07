import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const dbSource = readFileSync(new URL('../extension/db.js', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const confirmationSource = dashboardSource.slice(
  dashboardSource.indexOf('async function confirmExport(){'),
  dashboardSource.indexOf('function assertOwnAccount(){'),
);

test('two panels confirm different months through real IndexedDB transactions without losing either receipt', async () => {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<title>Ledger test</title>'}));
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    for (const page of pages) {
      await page.goto('https://ledger.test/');
      await page.evaluate(async moduleUrl => { globalThis.ledgerDb = await import(moduleUrl); },
        'data:text/javascript;base64,' + Buffer.from(dbSource).toString('base64'));
    }
    await pages[0].evaluate(() => ledgerDb.put('settings', {'2025-12': 'older'}, 'ledger'));
    await Promise.all(pages.map((page, index) => page.evaluate(async ({code, month}) => {
      const db = globalThis.ledgerDb;
      const uid = '1000000001';
      let pendingExport = {
        uid, month, ledgerKey: 'ledger', batches: [{month, revision: month}],
        downloadIds: [1], hasFailures: false,
      };
      const panelUI = {state: {phase: 'downloaded'}, dispatch(event) {
        this.state.phase = event.type === 'VERIFY' ? 'verifying' : event.type === 'CONFIRMED' ? 'done' : 'downloaded';
        return this.state;
      }};
      const isWizardBusy = () => false;
      const activeControls = () => {};
      const exportDownloadState = async () => 'complete';
      const refresh = async () => {};
      const $ = () => ({options: []});
      const status = () => {};
      const normalizeExtensionError = error => error;
      const confirm = eval('(' + code + ')');
      await confirm();
      if (panelUI.state.phase !== 'done' || pendingExport !== null) throw new Error('confirmation did not complete');
    }, {code: confirmationSource, month: index ? '2026-11' : '2026-10'})));
    assert.deepEqual(await pages[0].evaluate(() => ledgerDb.get('settings', 'ledger')),
      {'2025-12': 'older', '2026-10': '2026-10', '2026-11': '2026-11'});

    const aborted = await pages[0].evaluate(async () => {
      try { await ledgerDb.mergeSetting('ledger', {'2026-12': () => {}}); }
      catch (error) { return error.name; }
    });
    assert.equal(aborted, 'DataCloneError');
    assert.equal(Object.keys(await pages[1].evaluate(() => ledgerDb.get('settings', 'ledger'))).length, 3);
    await pages[1].evaluate(() => ledgerDb.mergeSetting('new-ledger', {'2026-12': 'retry'}));
    assert.deepEqual(await pages[0].evaluate(() => ledgerDb.get('settings', 'new-ledger')), {'2026-12': 'retry'});
  } finally {
    await browser.close();
  }
});
