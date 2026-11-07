import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeExportMediaURL} from '../extension/media-data.js';

const source = readFileSync(new URL('../extension/dashboard.js', import.meta.url), 'utf8');
const owner = '1000000081', other = '1000000082';
const avatar = 'https://tvax1.sinaimg.cn/crop.0.0.96.96.180/synthetic-recovered.jpg?Expires=9999999999&ssig=synthetic';
const diagnostics = (pageAvatar = avatar, pageUid = owner) => ({pageUid, pageAvatar, pageName:'合成补取账号', restricted:false});

function operation(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function \w+\(/);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

function harness({responses = [], sleepGate = null, sendGate = null, cacheError = null} = {}) {
  const calls = {delays:[], messages:[], avatars:[], cache:[]};
  const sending = deferred();
  let responseIndex = 0;
  const context = vm.createContext({
    uid:owner, connectionVersion:1,
    accountAvatarURL:value => {
      const url = normalizeExportMediaURL(value);
      if (!url) return '';
      const host = new URL(url).hostname;
      return host === 'sinaimg.cn' || host.endsWith('.sinaimg.cn') ? url : '';
    },
    sleep:async delay => {calls.delays.push(delay); if (sleepGate) await sleepGate.promise;},
    send:async type => {
      calls.messages.push(type);
      sending.resolve();
      if (sendGate) await sendGate.promise;
      const value = responses[responseIndex++] ?? {ok:true, diagnostics:diagnostics('')};
      if (value instanceof Error) throw value;
      return value;
    },
    panelUI:{setAccountAvatar:(uid, url) => calls.avatars.push({uid, url})},
    db:{saveTargetAvatar:async (uid, url) => {
      calls.cache.push({uid, url});
      if (cacheError) throw cacheError;
    }},
  });
  vm.runInContext(`${operation('updateAccountAvatar')}\n${operation('recoverAccountAvatar')}`, context);
  return {
    context, calls, sending:sending.promise,
    recover:() => vm.runInContext(`recoverAccountAvatar('${owner}', 1)`, context),
    update:(value, uid = owner, version = 1) => {
      context.inputDiagnostics = value;
      context.inputOwner = uid;
      context.inputVersion = version;
      return vm.runInContext('updateAccountAvatar(inputDiagnostics,inputOwner,inputVersion)', context);
    },
  };
}

test('a late profile avatar is filled without waiting for collection and polling stops after recovery', async () => {
  const {recover, calls} = harness({responses:[
    {ok:true, diagnostics:diagnostics('')},
    {ok:true, diagnostics:diagnostics('//tvax1.sinaimg.cn/synthetic-late.jpg')},
    {ok:true, diagnostics:diagnostics(avatar)},
  ]});
  await recover();
  assert.deepEqual(calls.delays, [500, 1000]);
  assert.deepEqual(calls.messages, ['WOB_PROFILE','WOB_PROFILE']);
  assert.deepEqual(calls.avatars, [{uid:owner, url:'https://tvax1.sinaimg.cn/synthetic-late.jpg'}]);
  assert.deepEqual(calls.cache, calls.avatars);
});

test('missing or rejected avatar URLs exhaust only the bounded recovery schedule', async () => {
  const {recover, calls} = harness({responses:[
    {ok:true, diagnostics:diagnostics('https://sinaimg.cn.evil.test/synthetic.jpg')},
    {ok:true, diagnostics:diagnostics('data:image/png;base64,AAAA')},
  ]});
  await recover();
  assert.deepEqual(calls.delays, [500, 1000, 2000, 4000, 8000]);
  assert.equal(calls.messages.length, 5);
  assert.deepEqual(calls.avatars, []);
  assert.deepEqual(calls.cache, []);
});

test('changing account or reconnecting while recovery sleeps cancels the old request', async () => {
  for (const change of ['account', 'connection']) {
    const gate = deferred();
    const {recover, calls, context} = harness({sleepGate:gate, responses:[{ok:true, diagnostics:diagnostics()}]});
    const task = recover();
    assert.deepEqual(calls.delays, [500]);
    if (change === 'account') context.uid = other;
    else context.connectionVersion = 2;
    gate.resolve();
    await task;
    assert.deepEqual(calls.messages, []);
    assert.deepEqual(calls.avatars, []);
    assert.deepEqual(calls.cache, []);
  }
});

test('a late profile response cannot overwrite a new account or a newer same-account connection', async () => {
  for (const change of ['account', 'connection']) {
    const gate = deferred();
    const {recover, calls, context, sending} = harness({sendGate:gate, responses:[{ok:true, diagnostics:diagnostics()}]});
    const task = recover();
    await sending;
    assert.deepEqual(calls.messages, ['WOB_PROFILE']);
    if (change === 'account') context.uid = other;
    else context.connectionVersion = 2;
    gate.resolve();
    await task;
    assert.deepEqual(calls.avatars, []);
    assert.deepEqual(calls.cache, []);
    assert.equal(calls.delays.length, 1);
  }
});

test('restricted pages, another profile and message failures stop optional recovery safely', async () => {
  const terminalResponses = [
    {ok:false, error:'synthetic adapter unavailable'},
    {ok:true, diagnostics:{...diagnostics(), restricted:true}},
    {ok:true, diagnostics:diagnostics(avatar, other)},
    new Error('synthetic tab unavailable'),
  ];
  for (const response of terminalResponses) {
    const {recover, calls} = harness({responses:[response, {ok:true, diagnostics:diagnostics()}]});
    await assert.doesNotReject(recover());
    assert.equal(calls.messages.length, 1);
    assert.deepEqual(calls.avatars, []);
    assert.deepEqual(calls.cache, []);
  }
});

test('a scan avatar preserves the signed query and invalid or stale scans cannot change account metadata', async () => {
  const {update, calls, context} = harness();
  await update(diagnostics(avatar.replace('https:', 'http:')));
  assert.deepEqual(calls.avatars, [{uid:owner, url:avatar}]);
  assert.deepEqual(calls.cache, calls.avatars);
  for (const value of [null, diagnostics(''), diagnostics(avatar, other), {...diagnostics(), restricted:true},
    diagnostics('https://example.test/synthetic.jpg')]) await update(value);
  await update(diagnostics(), owner, 0);
  context.uid = other;
  await update(diagnostics());
  assert.equal(calls.avatars.length, 1);
  assert.equal(calls.cache.length, 1);
});

test('an optional avatar cache failure cannot interrupt a successful page scan or recovery', async () => {
  const direct = harness({cacheError:new Error('synthetic storage unavailable')});
  await assert.doesNotReject(direct.update(diagnostics()));
  assert.deepEqual(direct.calls.avatars, [{uid:owner, url:avatar}]);
  const delayed = harness({cacheError:new Error('synthetic storage unavailable'), responses:[{ok:true, diagnostics:diagnostics()}]});
  await assert.doesNotReject(delayed.recover());
  assert.deepEqual(delayed.calls.avatars, [{uid:owner, url:avatar}]);
  assert.equal(delayed.calls.messages.length, 1);
});

test('connection uses the cached avatar immediately but still starts nonblocking recovery when the live avatar is missing', async () => {
  for (const liveAvatar of ['', avatar]) {
    const pendingRecovery = deferred();
    const calls = {accounts:[], recovery:[], saved:[]};
    const nodes = new Map();
    const context = vm.createContext({
      uid:'', tabId:1, connectionVersion:0, latestScan:null, pendingExport:null,
      $:id => {if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id);},
      panelUI:{dispatch() {}, setAccount:(...args) => calls.accounts.push(args)},
      chrome:{tabs:{get:async () => ({url:`https://weibo.com/u/${owner}`})}, scripting:{executeScript:async () => []}},
      send:async () => ({ok:true, diagnostics:diagnostics(liveAvatar)}),
      validProfile:() => true, accountAvatarURL:value => value || '', status() {}, refresh:async () => {},
      db:{get:async () => ({uid:owner, avatar:'https://tvax2.sinaimg.cn/synthetic-cached.jpg'}),
        put:async (_store, value) => calls.saved.push(value)},
      recoverAccountAvatar:(...args) => {calls.recovery.push(args); return pendingRecovery.promise;},
    });
    vm.runInContext(operation('connect'), context);
    assert.equal(await vm.runInContext('connect()', context), true);
    assert.equal(calls.accounts.length, 1);
    assert.equal(calls.accounts[0][3], liveAvatar || 'https://tvax2.sinaimg.cn/synthetic-cached.jpg');
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.recovery.length, liveAvatar ? 0 : 1);
    if (!liveAvatar) assert.deepEqual(calls.recovery[0], [owner, 1]);
    pendingRecovery.resolve();
  }
});
