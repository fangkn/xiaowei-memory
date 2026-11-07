import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createWizardState, transitionWizard, isWizardBusy} from '../extension/wizard-state.js';

const source = readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const UID = '1234567890';
function extract(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'expected dashboard operation must exist');
  return source.slice(from, to);
}
function stateController(state) {
  return {get state() { return state; }, dispatch(event) { state = transitionWizard(state, event); return state; }};
}
function fields() {
  const nodes = new Map();
  return id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', hidden: false, disabled: false,
      options: [{value: '2026-11'}, {value: '2026-12'}]});
    return nodes.get(id);
  };
}

function backupHarness({changedUid = false, connectBarrier = Promise.resolve(), startResult = 'ready', startError = null} = {}) {
  const ui = stateController(transitionWizard(transitionWizard(createWizardState(), {type: 'CONNECTION', connected: true}), {type: 'NEXT'}));
  const calls = {connections: 0, starts: 0};
  const context = vm.createContext({
    uid: UID, running: false, exporting: false, pendingExport: null,
    panelUI: ui, isWizardBusy, $: fields(), status() {}, activeControls() {},
    async connect() {
      calls.connections++;
      await connectBarrier;
      if (changedUid) context.uid = '9876543210';
      ui.dispatch({type: 'CONNECTION', connected: true});
    },
    async saveOptions() {},
    async start() { calls.starts++; ui.dispatch({type: 'STARTED'}); if (startError) throw startError; return startResult; },
    async startHistory() { calls.starts++; ui.dispatch({type: 'STARTED'}); },
    async refresh() {},
  });
  vm.runInContext(extract('async function beginBackup(){', 'function openExport(){'), context);
  return {ui, calls, context, run: () => vm.runInContext('beginBackup()', context)};
}

test('a second click while connecting cannot start a second collection', async () => {
  let release;
  const connectBarrier = new Promise(resolve => { release = resolve; });
  const harness = backupHarness({connectBarrier});
  const first = harness.run();
  assert.equal(harness.ui.state.phase, 'preparing');
  await harness.run();
  assert.equal(harness.calls.connections, 1);
  release();
  await first;
  assert.equal(harness.calls.starts, 1);
});

test('changing the source profile after confirmation requires confirming the new account', async () => {
  const harness = backupHarness({changedUid: true});
  await harness.run().catch(() => {});
  assert.equal(harness.calls.starts, 0, 'must not collect a different profile silently');
  assert.equal(harness.ui.state.step, 1);
  assert.equal(harness.ui.state.phase, 'idle');
});

test('a delayed older profile connection cannot bind its avatar to a newer account', async () => {
  let owner = '1000000001', releaseOldRead, reachedOldRead;
  const oldRead = new Promise(resolve => {releaseOldRead = resolve;});
  const reading = new Promise(resolve => {reachedOldRead = resolve;});
  const accounts = [], writes = [];
  let reads = 0;
  const context = vm.createContext({uid:'', tabId:1, connectionVersion:0, latestScan:null, pendingExport:null,
    $:fields(), panelUI:{dispatch() {}, setAccount(...args) {accounts.push(args);}},
    chrome:{tabs:{get:async () => ({url:`https://weibo.com/u/${owner}`})}, scripting:{executeScript:async () => []}},
    send:async () => ({ok:true, diagnostics:{pageUid:owner, pageName:`合成账号${owner}`, pageAvatar:`https://tvax1.sinaimg.cn/${owner}.jpg`}}),
    validProfile:() => true, accountAvatarURL:value => value || '', status() {}, refresh:async () => {},
    db:{get:async () => {if (++reads === 1) {reachedOldRead(); await oldRead;} return null;},
      put:async (_store, value) => writes.push(value)},
  });
  vm.runInContext(extract('async function connect(){', 'async function exportSelection('), context);
  const first = vm.runInContext('connect()', context);
  await reading;
  owner = '1000000002';
  assert.equal(await vm.runInContext('connect()', context), true);
  releaseOldRead();
  assert.equal(await first, false);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0][0], owner);
  assert.equal(accounts[0][3], `https://tvax1.sinaimg.cn/${owner}.jpg`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uid, owner);
  assert.equal(writes[0].avatar, accounts[0][3]);
  assert.equal(vm.runInContext('uid', context), owner);
});

test('collection settles with the real result and never completes after a failed final save', async () => {
  for (const startResult of ['ready','paused','error']) {
    const harness = backupHarness({startResult});
    await harness.run();
    assert.equal(harness.ui.state.collectionOutcome, startResult);
    assert.equal(harness.ui.state.phase, 'idle');
  }
  const failed = backupHarness({startError:new Error('保存检查点失败')});
  await assert.rejects(failed.run(), /保存检查点失败/);
  assert.equal(failed.ui.state.collectionOutcome, 'error');
  assert.equal(failed.ui.state.phase, 'idle');
});

test('pausing during the final collection save returns a saved pause instead of a stale stopping message', async () => {
  const ui = stateController(transitionWizard(transitionWizard(transitionWizard(createWizardState(),
    {type:'CONNECTION',connected:true}), {type:'NEXT'}), {type:'PREPARE'}));
  const $ = fields();
  $('scroll').checked = false;
  let releaseSave, reachedSave;
  const saveGate = new Promise(resolve => {releaseSave = resolve;});
  const saving = new Promise(resolve => {reachedSave = resolve;});
  const context = vm.createContext({uid:UID, running:false, exporting:false, generation:0, latestScan:null,
    panelUI:ui, $, activeControls() {}, status:text => {$('status').textContent = text;},
    navigator:{locks:{request:async (_name, _options, callback) => callback({})}},
    scanOnce:async () => ({updates:1,discovered:1,reposts:0}),
    db:{put:async () => {reachedSave(); await saveGate;}},
  });
  vm.runInContext(extract('async function start(){', 'function usableMedia('), context);
  const task = vm.runInContext('start()', context);
  await saving;
  vm.runInContext('pause()', context);
  assert.equal(ui.state.phase, 'stopping');
  assert.match($('status').textContent, /正在暂停/);
  releaseSave();
  assert.equal(await task, 'paused');
  assert.match($('status').textContent, /进度已保存/);
  assert.doesNotMatch($('status').textContent, /正在暂停/);
});

function confirmationHarness({downloadState = 'complete', failRefreshOnce = false, failLedgerOnce = false} = {}) {
  let state = transitionWizard(createWizardState(), {type: 'SAVED', count: 2});
  for (const type of ['OPEN_EXPORT', 'EXPORTING']) state = transitionWizard(state, {type});
  state = transitionWizard(state, {type: 'DOWNLOAD', canConfirm: true});
  const ui = stateController(state), calls = {ledgerWrites: 0, refreshes: 0, downloads: []};
  const context = vm.createContext({
    uid: UID,
    pendingExport: {uid: UID, month: '2026-11', revision: 'snapshot-revision', downloadId: 7, hasFailures: false},
    panelUI: ui, isWizardBusy, $: fields(), status() {}, activeControls() {},
    chrome: {runtime: {id: 'test-extension', getManifest: () => ({version: '0.6.9'})}, downloads: {search: async query => { calls.downloads.push(query.id); return [{state: downloadState}]; }}},
    monthLedgerKey: owner => `monthly:${owner}`,
    db: {mergeSetting: async () => {
      calls.ledgerWrites++;
      if (failLedgerOnce && calls.ledgerWrites === 1) throw new Error('ledger unavailable');
    }},
    refresh: async () => {
      calls.refreshes++;
      if (failRefreshOnce && calls.refreshes === 1) throw new Error('refresh unavailable');
    },
  });
  vm.runInContext(readFileSync(new URL('../extension/browser-export.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(extract('async function confirmExport(){', 'function assertOwnAccount(){'), context);
  return {ui, calls, context, run: () => vm.runInContext('confirmExport()', context)};
}

test('a download still in progress cannot write the ledger or finish the wizard', async () => {
  const harness = confirmationHarness({downloadState: 'in_progress'});
  await assert.rejects(harness.run(), /下载完成/);
  assert.equal(harness.ui.state.phase, 'downloaded');
  assert.equal(harness.calls.ledgerWrites, 0);
  assert.ok(harness.context.pendingExport);
});

test('ledger write failures retain the snapshot for a later confirmation retry', async () => {
  const harness = confirmationHarness({failLedgerOnce: true});
  await assert.rejects(harness.run(), /ledger unavailable/);
  assert.equal(harness.ui.state.phase, 'downloaded');
  assert.ok(harness.context.pendingExport);
  await harness.run();
  assert.equal(harness.ui.state.phase, 'done');
  assert.equal(harness.ui.state.month, '2026-11');
  assert.equal(harness.context.pendingExport, null);
});

test('a refresh failure after ledger persistence still permits confirming that snapshot again', async () => {
  const harness = confirmationHarness({failRefreshOnce: true});
  await assert.rejects(harness.run(), /refresh unavailable/);
  assert.equal(harness.ui.state.phase, 'downloaded');
  assert.ok(harness.context.pendingExport, 'failed refresh must not discard the only confirmation context');
  await harness.run();
  assert.equal(harness.ui.state.phase, 'done');
  assert.equal(harness.ui.state.month, '2026-11');
  assert.deepEqual(harness.calls.downloads, [7, 7]);
});
