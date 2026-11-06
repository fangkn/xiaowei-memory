import test from 'node:test';
import assert from 'node:assert/strict';
import {createWizardState, transitionWizard, isWizardBusy} from '../extension/wizard-state.js';

const move = (state, type, payload = {}) => transitionWizard(state, {type, ...payload});
function connectedScope(mode = 'page') {
  let state = move(createWizardState(), 'CONNECTION', {connected: true});
  state = move(state, 'NEXT');
  return move(state, 'MODE', {mode});
}
function readyExport() {
  return move(move(createWizardState(), 'SAVED', {count: 2}), 'OPEN_EXPORT');
}
function downloaded(canConfirm = true) {
  return move(move(readyExport(), 'EXPORTING'), 'DOWNLOAD', {canConfirm});
}
function assertUnchanged(state, type, payload = {}) {
  assert.deepEqual(move(state, type, payload), state, `${type} must not change this stage`);
}

test('a disconnected account cannot advance or begin collection', () => {
  const state = createWizardState();
  assert.equal(state.step, 1);
  assert.equal(state.phase, 'idle');
  assert.equal(isWizardBusy(state), false);
  for (const type of ['NEXT', 'PREPARE', 'STARTED', 'OPEN_EXPORT', 'EXPORTING', 'VERIFY', 'CONFIRMED']) {
    assertUnchanged(state, type, {month: '2026-11'});
  }
});

test('local records allow direct export without claiming a live account connection', () => {
  let state = move(createWizardState(), 'SAVED', {count: 8});
  assert.equal(state.connected, false);
  assertUnchanged(state, 'NEXT');
  assertUnchanged(state, 'PREPARE');
  state = move(state, 'OPEN_EXPORT');
  assert.equal(state.step, 4);
  assert.equal(state.connected, false);
  state = move(state, 'EXPORTING');
  assert.equal(state.phase, 'exporting');
});

test('a live account advances to range selection and can choose historical collection', () => {
  let state = connectedScope('history');
  assert.equal(state.step, 2);
  assert.equal(state.mode, 'history');
  assert.equal(state.connected, true);
  state = move(state, 'PREPARE');
  assert.equal(state.step, 2);
  assert.equal(state.phase, 'preparing');
  assert.equal(isWizardBusy(state), true);
});

test('preparing a task blocks repeated starts, navigation and mode changes', () => {
  const state = move(move(connectedScope('history'), 'SAVED', {count: 4}), 'PREPARE');
  for (const type of ['PREPARE', 'NEXT', 'BACK', 'RESELECT', 'OPEN_EXPORT', 'RESET', 'EXPORTING']) {
    assertUnchanged(state, type);
  }
  assertUnchanged(state, 'MODE', {mode: 'page'});
  const running = move(state, 'STARTED');
  assert.equal(running.phase, 'collecting');
  assert.equal(running.mode, 'history');
});

test('collecting and stopping both remain locked until pending work settles', () => {
  let state = move(move(move(connectedScope(), 'SAVED', {count: 3}), 'PREPARE'), 'STARTED');
  for (const phase of ['collecting', 'stopping']) {
    assert.equal(state.phase, phase);
    assert.equal(isWizardBusy(state), true);
    for (const type of ['PREPARE', 'BACK', 'RESELECT', 'OPEN_EXPORT', 'RESET']) assertUnchanged(state, type);
    assertUnchanged(state, 'MODE', {mode: 'history'});
    if (phase === 'collecting') state = move(state, 'STOPPING');
  }
  state = move(state, 'SETTLED');
  assert.equal(state.phase, 'idle');
  assert.equal(state.step, 3);
  assert.equal(isWizardBusy(state), false);
  assert.equal(move(state, 'OPEN_EXPORT').step, 4);
});

test('an interrupted history task stays on progress and can resume without losing the mode', () => {
  let state = move(move(connectedScope('history'), 'PREPARE'), 'STARTED');
  state = move(state, 'SETTLED');
  assert.equal(state.step, 3);
  assert.equal(state.mode, 'history');
  assertUnchanged(state, 'OPEN_EXPORT');
  state = move(state, 'PREPARE');
  assert.equal(state.phase, 'preparing');
  assert.equal(state.mode, 'history');
});

test('empty collection offers retry rather than an empty export', () => {
  let state = move(move(connectedScope(), 'PREPARE'), 'STARTED');
  state = move(state, 'SETTLED');
  assertUnchanged(state, 'OPEN_EXPORT');
  state = move(state, 'RESELECT');
  assert.equal(state.step, 2);
  assert.equal(state.phase, 'idle');
});

test('a lost live connection prevents a fresh collection even when data is saved', () => {
  const state = move(move(connectedScope(), 'SAVED', {count: 5}), 'CONNECTION', {connected: false});
  assertUnchanged(state, 'PREPARE');
  assert.equal(move(state, 'OPEN_EXPORT').step, 4);
});

test('export locks its stage and a failure returns to retry without completing the wizard', () => {
  let state = move(readyExport(), 'EXPORTING');
  assert.equal(isWizardBusy(state), true);
  for (const type of ['BACK', 'RESET', 'OPEN_EXPORT', 'NEXT_MONTH', 'EXPORTING']) assertUnchanged(state, type);
  state = move(state, 'EXPORT_FAILED');
  assert.equal(state.step, 4);
  assert.equal(state.phase, 'idle');
  assert.equal(isWizardBusy(state), false);
  assertUnchanged(state, 'VERIFY');
  assertUnchanged(state, 'CONFIRMED', {month: '2026-11'});
  assert.equal(move(state, 'EXPORTING').phase, 'exporting');
});

test('a download containing failed attachments cannot be confirmed', () => {
  const state = downloaded(false);
  assert.notEqual(state.phase, 'done');
  assertUnchanged(state, 'VERIFY');
  assertUnchanged(state, 'CONFIRMED', {month: '2026-11'});
});

test('a successful ZIP still waits for verification and a completed download', () => {
  let state = downloaded();
  assert.equal(state.phase, 'downloaded');
  assertUnchanged(state, 'CONFIRMED', {month: '2026-11'});
  state = move(state, 'VERIFY');
  assert.equal(state.phase, 'verifying');
  assert.equal(isWizardBusy(state), true);
  assertUnchanged(state, 'BACK');
  state = move(state, 'VERIFY_FAILED');
  assert.equal(state.phase, 'downloaded');
  assert.notEqual(state.phase, 'done');
  state = move(state, 'VERIFY');
  state = move(state, 'CONFIRMED', {month: '2026-11'});
  assert.equal(state.phase, 'done');
  assert.equal(state.step, 4);
});

test('changing export inputs invalidates an unconfirmed snapshot', () => {
  const state = move(downloaded(), 'INVALIDATE_DOWNLOAD');
  assert.equal(state.phase, 'idle');
  assertUnchanged(state, 'VERIFY');
  assertUnchanged(state, 'CONFIRMED', {month: '2026-11'});
});

test('another month starts a separate export and cannot reuse the previous confirmation', () => {
  let state = move(move(downloaded(), 'VERIFY'), 'CONFIRMED', {month: '2026-10'});
  state = move(state, 'NEXT_MONTH');
  assert.equal(state.step, 4);
  assert.equal(state.phase, 'idle');
  assertUnchanged(state, 'VERIFY');
  assertUnchanged(state, 'CONFIRMED', {month: '2026-11'});
  state = move(move(move(move(state, 'EXPORTING'), 'DOWNLOAD', {canConfirm: true}), 'VERIFY'), 'CONFIRMED', {month: '2026-11'});
  assert.equal(state.phase, 'done');
});

test('state transitions do not mutate the previous state or accept unknown modes', () => {
  const state = Object.freeze(connectedScope());
  const snapshot = {...state};
  assertUnchanged(state, 'MODE', {mode: 'unsupported'});
  move(state, 'PREPARE');
  assert.deepEqual(state, snapshot);
});
