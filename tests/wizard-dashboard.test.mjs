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

function backupHarness({changedUid = false, connectBarrier = Promise.resolve()} = {}) {
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
    async start() { calls.starts++; ui.dispatch({type: 'STARTED'}); },
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
    db: {get: async () => ({}), put: async () => {
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
