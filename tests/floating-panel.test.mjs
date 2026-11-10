import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const extensionId = 'test-extension';
const extensionURL = `chrome-extension://${extensionId}/`;
const profileURL = 'https://weibo.com/u/1000000001';
const plain = value => JSON.parse(JSON.stringify(value));

function backgroundHarness({ failInjection = false, failRelay = false } = {}) {
  const calls = { injections: [], messages: [], badges: [], titles: [], tabs: [] };
  const handlers = {};
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: path => extensionURL + path,
      onMessage: { addListener: listener => { handlers.message = listener; } },
    },
    action: {
      onClicked: { addListener: listener => { handlers.action = listener; } },
      setBadgeText: async value => { calls.badges.push(value); },
      setTitle: async value => { calls.titles.push(value); },
    },
    scripting: {
      executeScript: async value => {
        calls.injections.push(value);
        if (failInjection) throw new Error('The source tab is unavailable');
      },
    },
    tabs: {
      create: async value => { calls.tabs.push(value); },
      sendMessage: async (...args) => {
        calls.messages.push(args);
        if (failRelay) throw new Error('No receiving end');
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(source('background.js').replace(/^import .*;\r?\n/gm, ''), { chrome, URL, console: { error() {} },
    createReferrerMediaReader: () => async () => { throw new Error('Image reader is outside the panel test'); } });
  const sender = {
    id: extensionId,
    url: extensionURL + 'dashboard.html?embedded=1',
    frameId: 3,
    tab: { id: 42, url: profileURL },
  };
  async function message(value, origin = sender) {
    let responded = false;
    let keptAlive;
    const response = await new Promise(resolve => {
      keptAlive = handlers.message(value, origin, data => { responded = true; resolve(data); });
      if (!keptAlive && !responded) resolve(undefined);
    });
    return { response: response === undefined ? undefined : plain(response), keptAlive };
  }
  return { calls, handlers, sender, message };
}

test('panel context binds to the browser-provided tab and ignores a caller-supplied tab ID', async () => {
  const { message, calls } = backgroundHarness();
  assert.deepEqual((await message({ type: 'WOB_PANEL_CONTEXT', tabId: 999 })).response, { ok: true, tabId: 42 });
  assert.equal(calls.messages.length, 0);
});

async function dashboardSourceHarness({ query, insideFrame, rejectContext = false }) {
  const frameWindow = {};
  frameWindow.parent = insideFrame ? {} : frameWindow;
  const dashboard = source('dashboard.js');
  const tabDeclaration = dashboard.match(/^let tabId=.*;$/m)?.[0];
  const initializeStart = dashboard.indexOf('async function initialize() {');
  const initializeEnd = dashboard.indexOf("const main = document.querySelector('main');", initializeStart);
  assert.ok(tabDeclaration && initializeStart >= 0 && initializeEnd > initializeStart, 'dashboard source initialization must remain testable');
  const background = backgroundHarness();
  const sourceSender = { ...background.sender, url: extensionURL + 'dashboard.html' + query };
  const calls = [];
  const fields = new Map();
  const statuses = [];
  const context = vm.createContext({
    URL,
    window: frameWindow,
    location: { href: sourceSender.url },
    chrome: { runtime: { sendMessage: async message => {
      calls.push(plain(message));
      if (rejectContext) return { ok: false, error: '来源校验失败' };
      return (await background.message(message, sourceSender)).response;
    } } },
    db: { get: async () => undefined },
    $: id => { if (!fields.has(id)) fields.set(id, {}); return fields.get(id); },
    status: value => statuses.push(value),
    refresh: async () => {},
    showHistory: async () => {},
    panelUI: new Proxy({}, {get: () => () => {}}),
    connectedTabs: [],
  });
  // 执行真实嵌入判定与初始化代码，业务模块依赖由无副作用替身提供。
  vm.runInContext(source('wizard-state.js').replace(/^export /gm, ''), context);
  vm.runInContext(source('panel-ui.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(`${tabDeclaration}\nasync function connect() { connectedTabs.push(tabId); }\n${dashboard.slice(initializeStart, initializeEnd)}`, context);
  const initialTabId = vm.runInContext('tabId', context);
  await vm.runInContext('initialize()', context);
  return { initialTabId, embedded: vm.runInContext('embedded', context), finalTabId: vm.runInContext('tabId', context),
    connectedTabs: plain(context.connectedTabs), calls, statuses };
}

test('embedded dashboards ignore malicious tab query parameters and bind through the sender context', async () => {
  for (const query of ['?tab=999', '?embedded=0&tab=999', '?embedded=1&tab=999']) {
    const result = await dashboardSourceHarness({ query, insideFrame: true });
    assert.equal(result.embedded, true, query);
    assert.equal(result.initialTabId, null, query);
    assert.equal(result.finalTabId, 42, query);
    assert.deepEqual(result.connectedTabs, [42], query);
    assert.deepEqual(result.calls, [{ type: 'WOB_PANEL_CONTEXT' }], query);
  }
});

test('a failed iframe source check never falls back to a malicious tab query parameter', async () => {
  const result = await dashboardSourceHarness({ query: '?tab=999', insideFrame: true, rejectContext: true });
  assert.equal(result.finalTabId, null);
  assert.deepEqual(result.connectedTabs, []);
  assert.ok(result.statuses.some(status => status.includes('来源校验失败')));
});

test('legacy top-level dashboards retain the source tab query without impersonating an iframe', async () => {
  const result = await dashboardSourceHarness({ query: '?embedded=1&tab=999', insideFrame: false });
  assert.equal(result.embedded, false);
  assert.equal(result.finalTabId, 999);
  assert.deepEqual(result.connectedTabs, [999]);
  assert.deepEqual(result.calls, []);
});

test('panel requests reject foreign extensions, non-dashboard pages, top frames and offsite tabs', async () => {
  const { message, sender, calls } = backgroundHarness();
  const invalidSenders = [
    { ...sender, id: 'another-extension' },
    { ...sender, url: profileURL },
    { ...sender, url: extensionURL + 'other.html' },
    { ...sender, url: extensionURL + 'dashboard.html.evil' },
    { ...sender, frameId: 0 },
    { ...sender, tab: undefined },
    { ...sender, tab: { id: '42', url: profileURL } },
    { ...sender, tab: { id: 42, url: 'https://weibo.com.evil.test/' } },
  ];
  for (const origin of invalidSenders) {
    for (const type of ['WOB_PANEL_CONTEXT', 'WOB_PANEL_MINIMIZE', 'WOB_PANEL_CLOSE', 'WOB_PANEL_RESIZE', 'WOB_PANEL_ACTIVITY']) {
      assert.equal((await message({ type, height: 300, state: 'collecting' }, origin)).response.ok, false);
    }
  }
  assert.equal(calls.messages.length, 0);
});

test('panel relay scopes commands to source top frame and bounds resize and activity values', async () => {
  const { message, calls } = backgroundHarness();
  assert.equal((await message({ type: 'WOB_PANEL_MINIMIZE', tabId: 999, extra: 'ignored' })).keptAlive, true);
  assert.deepEqual(plain(calls.messages.at(-1)), [42, { type: 'WOB_PANEL_MINIMIZE' }, { frameId: 0 }]);
  assert.equal((await message({ type: 'WOB_PANEL_CLOSE', tabId: 999, extra: 'ignored' })).keptAlive, true);
  assert.deepEqual(plain(calls.messages.at(-1)), [42, { type: 'WOB_PANEL_CLOSE' }, { frameId: 0 }]);
  for (const [height, expected] of [[-1, 180], [249.1, 250], [5000, 720]]) {
    assert.equal((await message({ type: 'WOB_PANEL_RESIZE', height })).response.ok, true);
    assert.equal(calls.messages.at(-1)[1].height, expected);
  }
  for (const state of ['idle', 'collecting', 'exporting']) {
    assert.equal((await message({ type: 'WOB_PANEL_ACTIVITY', state })).response.ok, true);
    assert.equal(calls.messages.at(-1)[1].state, state);
  }
  const count = calls.messages.length;
  for (const height of [NaN, Infinity, '300', undefined]) {
    assert.equal((await message({ type: 'WOB_PANEL_RESIZE', height })).response.ok, false);
  }
  assert.equal((await message({ type: 'WOB_PANEL_ACTIVITY', state: 'execute' })).response.ok, false);
  assert.equal((await message({ type: 'UNSUPPORTED' })).response, undefined);
  assert.equal(calls.messages.length, count);
});

test('a missing panel receiver returns a recoverable response', async () => {
  const { message } = backgroundHarness({ failRelay: true });
  const result = await message({ type: 'WOB_PANEL_MINIMIZE' });
  assert.equal(result.response.ok, false);
  assert.match(result.response.error, /刷新/);
});

function panelHarness({ existingHosts = [] } = {}) {
  const nodes = [];
  const listeners = [];
  function element(tag) {
    const attributes = new Map();
    const events = new Map();
    const properties = new Map();
    const node = {
      tag, children: [], className: '', dataset: {}, attributes, events, parent: null,
      srcWrites: 0, focusCount: 0,
      style: { cssText: '', setProperty: (key, value) => properties.set(key, value), getPropertyValue: key => properties.get(key) },
      setAttribute: (key, value) => attributes.set(key, value),
      addEventListener: (type, callback) => events.set(type, callback),
      append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } },
      attachShadow(options) { this.shadowOptions = options; this.shadow = element('shadow'); return this.shadow; },
      focus() { this.focusCount++; },
      remove() {
        this.removed = true;
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
      },
    };
    node.classList = {
      add(name) { node.className = [...new Set([...node.className.split(' ').filter(Boolean), name])].join(' '); },
      remove(name) { node.className = node.className.split(' ').filter(value => value !== name).join(' '); },
      contains(name) { return node.className.split(' ').includes(name); },
    };
    Object.defineProperty(node, 'src', {
      get() { return this.source; },
      set(value) { this.source = value; this.srcWrites++; },
    });
    nodes.push(node);
    return node;
  }
  const root = element('html');
  const previousHosts = existingHosts.map(owner => {
    const previous = element('div');
    previous.id = 'weibo-obsidian-floating-panel';
    if (owner !== undefined) previous.dataset.extensionId = owner;
    root.append(previous);
    return previous;
  });
  const createContext = () => vm.createContext({
    document: { createElement: element, documentElement: root,
      querySelectorAll(selector) {
        assert.equal(selector, '[id="weibo-obsidian-floating-panel"]');
        return root.children.filter(node => node.id === 'weibo-obsidian-floating-panel');
      },
    },
    chrome: { runtime: { id: extensionId, getURL: path => extensionURL + path,
      onMessage: { addListener: listener => listeners.push(listener), removeListener: listener => {
        const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1);
      } } } },
  });
  let context = createContext();
  const inject = () => vm.runInContext(source('floating-panel.js'), context);
  const injectInNewWorld = () => { context = createContext(); inject(); };
  inject();
  const host = root.children.at(-1);
  const frame = nodes.find(node => node.tag === 'iframe');
  const wrapper = frame.parent.parent;
  const restore = nodes.find(node => node.tag === 'button');
  function message(value, sender = { id: extensionId }) {
    let response;
    for (const listener of [...listeners]) listener(value, sender, data => { response = data; });
    return response;
  }
  return { nodes, root, host, frame, wrapper, restore, inject, injectInNewWorld, message, listeners, previousHosts };
}

test('floating panel is isolated, injects one extension iframe and reuses it after repeated toolbar clicks', () => {
  const harness = panelHarness();
  const { host, root, frame, nodes, listeners } = harness;
  assert.equal(host.shadowOptions.mode, 'closed');
  assert.equal(host.dataset.extensionId, extensionId);
  assert.equal(frame.src, extensionURL + 'dashboard.html?embedded=1');
  assert.equal(frame.title, '小微记忆悬浮面板');
  harness.inject();
  harness.inject();
  assert.equal(root.children.length, 1);
  assert.equal(nodes.filter(node => node.tag === 'iframe').length, 1);
  assert.equal(frame.srcWrites, 1);
  assert.equal(listeners.length, 1);
});

test('a new extension world replaces its orphaned floating host while keeping exactly one current panel', () => {
  const { host, root, nodes, injectInNewWorld } = panelHarness();
  injectInNewWorld();
  assert.equal(host.removed, true);
  assert.equal(host.parent, null);
  assert.equal(root.children.length, 1);
  assert.notEqual(root.children[0], host);
  assert.equal(root.children[0].dataset.extensionId, extensionId);
  assert.equal(nodes.filter(node => node.tag === 'iframe').length, 2, 'a new iframe is created only for the new extension context');
});

test('new injection removes legacy and same-extension hosts but preserves a different installed instance', () => {
  const foreignExtension = 'separate-extension-instance';
  const { previousHosts, root, host, inject } = panelHarness({ existingHosts: [undefined, extensionId, foreignExtension] });
  assert.equal(previousHosts[0].removed, true, 'legacy unmarked host must not leave a dead duplicate');
  assert.equal(previousHosts[1].removed, true, 'same-extension orphan must be removed');
  assert.equal(previousHosts[2].removed, undefined, 'another extension installation must not be removed');
  assert.deepEqual(root.children, [previousHosts[2], host]);
  inject();
  assert.deepEqual(root.children, [previousHosts[2], host], 'normal repeated toolbar click retains both live panels');
  assert.equal(host.removed, undefined);
});

test('minimize and restore preserve the mounted iframe and its task context', () => {
  const { message, wrapper, restore, frame, inject, nodes } = panelHarness();
  const parent = frame.parent;
  assert.equal(message({ type: 'WOB_PANEL_MINIMIZE' }).ok, true);
  assert.equal(wrapper.classList.contains('collapsed'), true);
  assert.equal(restore.attributes.get('aria-expanded'), 'false');
  assert.equal(restore.focusCount, 1);
  restore.events.get('click')();
  assert.equal(wrapper.classList.contains('collapsed'), false);
  assert.equal(restore.attributes.get('aria-expanded'), 'true');
  message({ type: 'WOB_PANEL_MINIMIZE' });
  inject();
  assert.equal(wrapper.classList.contains('collapsed'), false);
  assert.equal(frame.parent, parent);
  assert.equal(frame.srcWrites, 1);
  assert.equal(nodes.some(node => node.removed), false);
});

test('close removes the entire idle panel and its listener, then toolbar injection can open a fresh panel', () => {
  const {message, root, host, frame, inject, nodes, listeners} = panelHarness();
  assert.equal(message({type:'WOB_PANEL_CLOSE'}).ok, true);
  assert.equal(host.removed, true);
  assert.equal(root.children.length, 0, 'closing leaves no restore button behind');
  assert.equal(listeners.length, 0, 'closed panel does not keep a runtime listener');
  assert.equal(message({type:'WOB_PANEL_MINIMIZE'}), undefined);
  inject();
  assert.equal(root.children.length, 1);
  assert.notEqual(root.children[0], host);
  assert.equal(nodes.filter(node => node.tag === 'iframe').length, 2);
  assert.equal(listeners.length, 1);
  assert.equal(frame.srcWrites, 1, 'old iframe is never reused after closure');
});

test('busy tasks and foreign senders cannot close the mounted panel', () => {
  const {message, root, host, wrapper} = panelHarness();
  assert.equal(message({type:'WOB_PANEL_CLOSE'}, {id:'other-extension'}), undefined);
  assert.equal(root.children.length, 1);
  for (const state of ['collecting','exporting']) {
    message({type:'WOB_PANEL_ACTIVITY',state});
    const result = message({type:'WOB_PANEL_CLOSE'});
    assert.equal(result.ok, false);
    assert.equal(result.busy, true);
    assert.equal(host.removed, undefined);
    assert.equal(wrapper.classList.contains('collapsed'), false, 'a busy close is not silently minimized');
  }
  message({type:'WOB_PANEL_ACTIVITY',state:'idle'});
  assert.equal(message({type:'WOB_PANEL_CLOSE'}).ok, true);
  assert.equal(root.children.length, 0);
});

test('minimized task status is accurate and foreign or invalid commands cannot change the panel', () => {
  const { message, wrapper, restore, frame } = panelHarness();
  const activity = restore.children.at(-1);
  for (const [state, label] of [['collecting', '采集中'], ['exporting', '处理中'], ['idle', '已就绪']]) {
    message({ type: 'WOB_PANEL_ACTIVITY', state });
    assert.equal(activity.textContent, label);
    assert.equal(restore.dataset.busy, String(state !== 'idle'));
  }
  assert.equal(message({ type: 'WOB_PANEL_MINIMIZE' }, { id: 'other-extension' }), undefined);
  assert.equal(wrapper.classList.contains('collapsed'), false);
  assert.equal(message({ type: 'WOB_PANEL_ACTIVITY', state: 'untrusted' }), undefined);
  assert.equal(activity.textContent, '已就绪');
  for (const [height, expected] of [[10, '180px'], [5000, '720px']]) {
    message({ type: 'WOB_PANEL_RESIZE', height });
    assert.equal(frame.parent.style.getPropertyValue('--panel-height'), expected);
  }
  assert.equal(message({ type: 'WOB_PANEL_RESIZE', height: Infinity }), undefined);
  assert.equal(frame.parent.style.getPropertyValue('--panel-height'), '720px');
});

test('only the dashboard document is web-accessible on the supported Weibo origins', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ['dashboard.html'],
    matches: ['https://weibo.com/*', 'https://www.weibo.com/*'],
  }]);
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.permissions.includes('debugger'), false);
});
