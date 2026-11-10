import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = () => readFileSync(new URL('../extension/launcher.js', import.meta.url), 'utf8');
const profileURL = 'https://weibo.com/u/1000000001';
const plain = value => JSON.parse(JSON.stringify(value));

function launcherHarness(options = {}) {
  const state = {tabs: [{id: 42, url: profileURL}], ...options};
  const calls = {queries: [], injections: [], creates: [], badges: [], titles: [], errors: [], closed: 0};
  const fields = new Map();
  for (const id of ['launcherTitle', 'launcherDescription', 'launcherActions', 'openWeibo', 'retryOpen', 'closeLauncher']) {
    const listeners = new Map();
    fields.set(id, {id, textContent: '', hidden: ['launcherActions', 'retryOpen'].includes(id), disabled: false,
      addEventListener: (type, handler) => listeners.set(type, handler),
      click: () => listeners.get('click')?.(),
    });
  }
  const chrome = {
    tabs: {
      query: async query => {
        calls.queries.push(plain(query));
        if (state.queryGate) await state.queryGate;
        if (state.failQuery) throw new Error('Synthetic query failure with private page details');
        return state.tabs;
      },
      create: async properties => {
        calls.creates.push(plain(properties));
        if (state.createGate) await state.createGate;
        if (state.failCreate) throw new Error('Synthetic create failure with private page details');
        return {id: 73};
      },
    },
    action: {
      setBadgeText: async value => {
        calls.badges.push(plain(value));
        if (state.failBadge) throw new Error('Synthetic badge failure');
      },
      setTitle: async value => {
        calls.titles.push(plain(value));
        if (state.failTitle) throw new Error('Synthetic title failure');
      },
    },
    scripting: {
      executeScript: async value => {
        calls.injections.push(plain(value));
        if (state.injectionGate) await state.injectionGate;
        if (state.failInjection) throw new Error('Synthetic injection failure with private page details');
        return [{frameId: 0}];
      },
    },
  };
  const ready = Promise.resolve(vm.runInNewContext(source(), {
    URL, chrome,
    document: {getElementById: id => {
      assert.ok(fields.has(id), `Unknown launcher element: ${id}`);
      return fields.get(id);
    }},
    window: {close: () => { calls.closed++; }},
    console: {error: (...values) => calls.errors.push(values)},
  }));
  return {state, calls, ready, $: id => fields.get(id)};
}

function assertGuidance(harness, {retry = false} = {}) {
  assert.equal(harness.$('launcherActions').hidden, false);
  assert.equal(harness.$('retryOpen').hidden, !retry);
  assert.equal(harness.$('openWeibo').disabled, false);
  assert.equal(harness.$('retryOpen').disabled, false);
  assert.equal(harness.calls.closed, 0);
  assert.deepEqual(harness.calls.errors, []);
  const copy = harness.$('launcherTitle').textContent + harness.$('launcherDescription').textContent;
  assert.match(copy, /微博|页面|重试/);
  assert.doesNotMatch(copy, /Synthetic|private page details|Error:|chrome:\/\//);
}

test('launcher injects once into the clicked Weibo top frame and closes without opening a tab', async () => {
  for (const url of [profileURL, 'https://www.weibo.com/u/1000000001', 'https://weibo.com/']) {
    const h = launcherHarness({tabs: [{id: 42, url}]});
    await h.ready;
    assert.deepEqual(h.calls.queries, [{active: true, currentWindow: true}]);
    assert.deepEqual(h.calls.injections, [{target: {tabId: 42, frameIds: [0]}, files: ['floating-panel.js']}]);
    assert.deepEqual(h.calls.creates, []);
    assert.equal(h.calls.closed, 1);
    assert.deepEqual(h.calls.errors, []);
  }
});

test('unrelated, restricted, missing and spoofed URLs show guidance without injecting or navigating', async () => {
  for (const url of ['https://example.test/', 'chrome://extensions/', 'edge://extensions/', 'about:blank',
    'chrome-extension://another-extension/page.html', 'file:///synthetic.html', 'http://weibo.com/u/1000000001',
    'https://weibo.com.evil.test/', 'https://evil.test/?next=https://weibo.com/', 'https://m.weibo.cn/',
    'https://weibo.com:8443/', 'https://user:password@weibo.com/', 'not a URL', '', undefined]) {
    const h = launcherHarness({tabs: [{id: 42, url}]});
    await h.ready;
    assertGuidance(h);
    assert.deepEqual(h.calls.injections, [], String(url));
    assert.deepEqual(h.calls.creates, [], String(url));
  }
});

test('missing tabs and invalid tab IDs cannot become injection targets', async () => {
  for (const tabs of [[], [undefined], [null], ...[undefined, NaN, Infinity, -1, 1.5, '42'].map(id => [{id, url: profileURL}])]) {
    const h = launcherHarness({tabs});
    await h.ready;
    assertGuidance(h);
    assert.deepEqual(h.calls.injections, []);
    assert.deepEqual(h.calls.creates, []);
  }
  const h = launcherHarness({tabs: [{id: 0, url: profileURL}]});
  await h.ready;
  assert.equal(h.calls.injections[0].target.tabId, 0);
  assert.equal(h.calls.closed, 1);
});

test('injection failures keep friendly recovery visible and retry re-queries the active tab', async () => {
  const h = launcherHarness({failInjection: true});
  await h.ready;
  assertGuidance(h, {retry: true});
  assert.deepEqual(h.calls.creates, []);
  h.state.failInjection = false;
  h.state.tabs = [{id: 84, url: 'https://www.weibo.com/'}];
  await h.$('retryOpen').click();
  assert.equal(h.calls.queries.length, 2);
  assert.equal(h.calls.injections.length, 2);
  assert.equal(h.calls.injections.at(-1).target.tabId, 84);
  assert.equal(h.calls.closed, 1);
});

test('retry after navigation to another origin returns to guidance without reinjection', async () => {
  const h = launcherHarness({failInjection: true});
  await h.ready;
  h.state.failInjection = false;
  h.state.tabs = [{id: 42, url: 'https://example.test/'}];
  await h.$('retryOpen').click();
  assertGuidance(h);
  assert.equal(h.calls.queries.length, 2);
  assert.equal(h.calls.injections.length, 1);
  assert.deepEqual(h.calls.creates, []);
});

test('a rejected tab query shows recovery and can be retried without an uncaught error', async () => {
  const h = launcherHarness({failQuery: true});
  await h.ready;
  assertGuidance(h, {retry: true});
  assert.deepEqual(h.calls.injections, []);
  h.state.failQuery = false;
  await h.$('retryOpen').click();
  assert.equal(h.calls.queries.length, 2);
  assert.equal(h.calls.injections.length, 1);
  assert.equal(h.calls.closed, 1);
});

test('unavailable toolbar metadata cleanup does not prevent a successful panel injection', async () => {
  for (const options of [{failBadge: true}, {failTitle: true}, {failBadge: true, failTitle: true}]) {
    const h = launcherHarness(options);
    await h.ready;
    assert.equal(h.calls.injections.length, 1);
    assert.equal(h.calls.closed, 1);
    assert.deepEqual(h.calls.errors, []);
  }
});

test('the explicit open button opens only the fixed Weibo URL and closes after success', async () => {
  const h = launcherHarness({tabs: [{id: 42, url: 'https://example.test/?redirect=https://evil.test/'}]});
  await h.ready;
  assert.deepEqual(h.calls.creates, []);
  await h.$('openWeibo').click();
  assert.deepEqual(h.calls.creates, [{url: 'https://weibo.com/', active: true}]);
  assert.deepEqual(h.calls.injections, []);
  assert.equal(h.calls.closed, 1);
});

test('a failed Weibo tab creation remains recoverable and does not close the launcher', async () => {
  const h = launcherHarness({tabs: [{id: 42, url: 'chrome://extensions/'}], failCreate: true});
  await h.ready;
  await h.$('openWeibo').click();
  assert.equal(h.calls.closed, 0);
  assert.equal(h.$('openWeibo').disabled, false);
  assert.equal(h.$('launcherActions').hidden, false);
  assert.deepEqual(h.calls.errors, []);
  assert.doesNotMatch(h.$('launcherDescription').textContent, /Synthetic|private page details/);
  h.state.failCreate = false;
  await h.$('openWeibo').click();
  assert.equal(h.calls.creates.length, 2);
  assert.ok(h.calls.creates.every(call => call.url === 'https://weibo.com/' && call.active));
  assert.equal(h.calls.closed, 1);
});

test('busy guards suppress duplicate opens and retries while tab creation is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = launcherHarness({tabs: [{id: 42, url: 'https://example.test/'}], createGate: gate});
  await h.ready;
  const first = h.$('openWeibo').click();
  assert.equal(h.$('openWeibo').disabled, true);
  assert.equal(h.$('retryOpen').disabled, true);
  await h.$('openWeibo').click();
  await h.$('retryOpen').click();
  assert.equal(h.calls.creates.length, 1);
  assert.equal(h.calls.queries.length, 1);
  assert.equal(h.calls.closed, 0);
  release();
  await first;
  assert.equal(h.calls.closed, 1);
});

test('busy guards suppress user actions until the first tab query has settled', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = launcherHarness({queryGate: gate});
  await h.$('openWeibo').click();
  await h.$('retryOpen').click();
  assert.equal(h.calls.queries.length, 1);
  assert.equal(h.calls.creates.length, 0);
  release();
  await h.ready;
  assert.equal(h.calls.injections.length, 1);
  assert.equal(h.calls.closed, 1);
});

test('the close button dismisses guidance without navigation or injection', async () => {
  const h = launcherHarness({tabs: []});
  await h.ready;
  await h.$('closeLauncher').click();
  assert.equal(h.calls.closed, 1);
  assert.deepEqual(h.calls.creates, []);
  assert.deepEqual(h.calls.injections, []);
});
