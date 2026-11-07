import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeExportMediaURL} from '../extension/media-data.js';

const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8');

function uiHarness({embedded = false, windowResponse = {ok:true}} = {}) {
  function element(id, dataset = {}) {
    const attributes = new Map(), listeners = new Map(), classes = new Set();
    return {id, dataset, value: '', hidden: false, disabled: false, checked: false, textContent: '', focusCount: 0,
      addEventListener: (type, fn) => listeners.set(type, fn),
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name),
      focus() { this.focusCount++; },
      click() { return listeners.get('click')?.(); },
      change() { listeners.get('change')?.(); },
      replaceWith(node) { fields.set(this.id, node); },
      classList: {toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name)},
      getBoundingClientRect: () => ({height: 320}),
    };
  }
  const fields = new Map();
  const $ = id => { if (!fields.has(id)) fields.set(id, element(id)); return fields.get(id); };
  const sections = [1, 2, 3, 4].map(step => element(`step-${step}`, {wizardStep: String(step)}));
  const dots = [1, 2, 3, 4].map(step => element(`dot-${step}`, {stepDot: String(step)}));
  const radios = ['page', 'history'].map(mode => Object.assign(element(mode), {value: mode}));
  $('batch').value = '2026-11';
  $('closePrompt').hidden = true;
  const browserWindow = {scrollTo() {}};
  browserWindow.parent = embedded ? {} : browserWindow;
  const messages = [];
  const context = vm.createContext({
    window: browserWindow, URL, normalizeExportMediaURL,
    document: {getElementById: $, querySelectorAll: selector =>
      selector === '[data-wizard-step]' ? sections : selector === '[data-step-dot]' ? dots :
      selector === 'input[name="backupMode"]' ? radios : [], createElement: () => element('')},
    ResizeObserver: class {observe() {}},
    requestAnimationFrame: callback => callback(),
    chrome: {runtime: {sendMessage: async message => { messages.push(JSON.parse(JSON.stringify(message))); return windowResponse; }}},
  });
  vm.runInContext(source('wizard-state.js').replace(/^export /gm, ''), context);
  vm.runInContext(source('panel-ui.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  const ui = vm.runInContext('setupPanelUI()', context);
  return {ui, $, sections, radios, messages};
}

test('the wizard shows one stage and distinguishes saved records from a connected profile', () => {
  const {ui, $, sections} = uiHarness();
  assert.equal(sections.filter(section => !section.hidden).length, 1);
  assert.equal($('wizardNext').disabled, true);
  assert.equal($('wizardNext').hidden, true);
  assert.equal($('wizardLocalExport').hidden, true);
  ui.setAccount('1234567890', '测试账号', true);
  ui.setSavedCount(5);
  assert.equal(ui.state.connected, false);
  assert.equal($('wizardNext').disabled, true);
  assert.equal($('connect').hidden, false);
  assert.equal($('wizardLocalExport').hidden, false);
  assert.equal($('wizardLocalExport').classList.contains('primary'), true);
  assert.equal($('wizardLocalExport').classList.contains('text-button'), false);
  assert.match($('accountUid').textContent, /本机已有记录/);
  ui.setAccount('1234567890', '测试账号');
  assert.equal($('wizardNext').disabled, false);
  assert.equal($('wizardNext').hidden, false);
  assert.equal($('wizardLocalExport').classList.contains('primary'), false);
  assert.equal($('wizardLocalExport').classList.contains('text-button'), true);
  assert.equal($('connect').hidden, true);
});

test('combined PDF explains one full document and restores monthly controls when switched back', () => {
  const {ui, $} = uiHarness();
  ui.setSavedCount(2);
  ui.dispatch({type: 'OPEN_EXPORT'});
  $('format').value = 'pdf-combined';
  $('batch').value = 'all';
  $('incremental').checked = true;
  ui.render();
  assert.equal($('incrementalOption').hidden, true);
  assert.equal($('incremental').disabled, true);
  assert.match($('export').textContent, /合并 PDF/);
  assert.match($('exportScopeHint').textContent, /以前导出过/);
  assert.match($('exportDestination').textContent, /一个 PDF/);
  assert.doesNotMatch($('doneHint').textContent, /ZIP|解压/);
  ui.dispatch({type: 'EXPORTING'});
  ui.dispatch({type: 'DOWNLOAD', canConfirm: false});
  assert.equal($('export').textContent, '重新生成合并 PDF');
  $('format').value = 'pdf';
  ui.dispatch({type: 'INVALIDATE_DOWNLOAD'});
  assert.equal($('incrementalOption').hidden, false);
  assert.equal($('incremental').disabled, false);
  assert.match($('export').textContent, /月度 PDF/);
  assert.match($('doneHint').textContent, /ZIP/);
});

test('account avatars validate their source, fall back on failure and ignore a previous account image load', () => {
  const {ui, $} = uiHarness();
  ui.setAccount('1000000001', '示例甲', false, '//tvax1.sinaimg.cn/crop.0.0.180.180/avatar-a.jpg');
  const first = $('accountAvatar');
  assert.equal(first.src, 'https://tvax1.sinaimg.cn/crop.0.0.180.180/avatar-a.jpg');
  assert.equal(first.referrerPolicy, 'no-referrer');
  assert.equal(first.hidden, true);
  first.naturalWidth = 180; first.onload();
  assert.equal(first.hidden, false);
  assert.equal($('accountAvatarFallback').getAttribute('hidden'), '');
  ui.setAccount('1000000002', '示例乙');
  assert.equal($('accountAvatar').hidden, true);
  first.onload();
  assert.equal($('accountAvatarFallback').getAttribute('hidden'), undefined, 'old account events cannot reveal the previous avatar');
  for (const source of ['javascript:alert(1)','https://sinaimg.cn.evil.test/avatar.png','https://user:pass@tvax1.sinaimg.cn/avatar.jpg','https://face.t.sinajs.cn/avatar.png']) {
    ui.setAccount('1000000002', '示例乙', false, source);
    assert.equal($('accountAvatar').src, undefined);
  }
  ui.setAccount('1000000002', '示例乙', true, 'http://tvax2.sinaimg.cn/avatar-b.jpg');
  const second = $('accountAvatar');
  assert.equal(second.src, 'https://tvax2.sinaimg.cn/avatar-b.jpg');
  second.onerror();
  assert.equal(second.hidden, true);
  assert.equal($('accountAvatarFallback').getAttribute('hidden'), undefined);
  assert.equal(ui.state.connected, false);
});

test('late avatar updates preserve the wizard, reuse pending images and retry failed images', () => {
  const {ui, $} = uiHarness();
  const owner = '1000000001', url = 'https://tvax1.sinaimg.cn/synthetic-avatar.jpg';
  ui.setAccount(owner, '合成账号');
  ui.dispatch({type:'NEXT'});
  ui.setAccountAvatar(owner,url);
  const pending = $('accountAvatar');
  ui.setAccountAvatar(owner,url);
  assert.equal($('accountAvatar'),pending, 'repeated scans must not restart an in-flight request');
  pending.naturalWidth=100; pending.onload();
  ui.setAccountAvatar(owner,url);
  assert.equal($('accountAvatar'),pending, 'a loaded image should not flicker');
  assert.equal(ui.state.step,2);
  assert.equal(ui.state.connected,true);
  assert.equal(ui.setAccountAvatar('1000000002',url),false);
  assert.equal($('accountAvatar'),pending);
  pending.onerror();
  ui.setAccountAvatar(owner,url);
  assert.notEqual($('accountAvatar'),pending, 'a failed request can be retried on the next observation');
  ui.setAccount('1000000002','合成乙',true,url);
  assert.equal(ui.state.connected,false);
  const current=$('accountAvatar');
  ui.setAccountAvatar(owner,url);
  assert.equal($('accountAvatar'),current);
  assert.equal(ui.state.connected,false);
});

test('range selection only reveals the options for the selected mode', () => {
  const {ui, $, sections, radios} = uiHarness();
  ui.setAccount('1234567890', '测试账号');
  ui.dispatch({type: 'NEXT'});
  assert.equal(sections.filter(section => !section.hidden).length, 1);
  assert.equal(sections[1].hidden, false);
  assert.equal($('stepTitle').focusCount, 1);
  assert.equal($('pageOptions').hidden, false);
  assert.equal($('historyOptions').hidden, true);
  radios[1].change();
  assert.equal(ui.state.mode, 'history');
  assert.equal($('pageOptions').hidden, true);
  assert.equal($('historyOptions').hidden, false);
  ui.dispatch({type: 'PREPARE'});
  assert.equal($('wizardStart').disabled, true);
  assert.equal(radios.every(radio => radio.disabled), true);
});

test('pause keeps retry and export unavailable until the collector has settled', () => {
  const {ui, $, sections} = uiHarness();
  ui.setAccount('1234567890', '测试账号');
  for (const type of ['NEXT', 'PREPARE', 'STARTED']) ui.dispatch({type});
  ui.setSavedCount(3);
  assert.equal(sections[2].hidden, false);
  assert.equal($('pause').hidden, false);
  assert.equal($('pause').disabled, false);
  assert.equal($('wizardToExport').disabled, true);
  ui.dispatch({type: 'STOPPING'});
  assert.equal($('pause').disabled, true);
  assert.equal($('wizardResume').hidden, true);
  assert.equal($('wizardReselect').hidden, true);
  assert.equal($('wizardToExport').disabled, true);
  ui.dispatch({type: 'SETTLED'});
  assert.equal($('pause').hidden, true);
  assert.equal($('wizardResume').hidden, false);
  assert.equal($('wizardToExport').disabled, false);
});

test('download failure and attachment failure never render a completed backup', () => {
  const {ui, $} = uiHarness();
  ui.setSavedCount(2);
  ui.dispatch({type: 'OPEN_EXPORT'});
  ui.dispatch({type: 'EXPORTING'});
  assert.equal($('export').disabled, true);
  assert.equal($('wizardExportBack').disabled, true);
  ui.dispatch({type: 'EXPORT_FAILED'});
  assert.equal($('exportDone').hidden, true);
  assert.equal($('exportReady').hidden, false);
  assert.equal($('confirmExport').hidden, true);
  assert.equal($('export').disabled, false);
  ui.dispatch({type: 'EXPORTING'});
  ui.dispatch({type: 'DOWNLOAD', canConfirm: false});
  assert.equal($('confirmExport').hidden, true);
  assert.equal($('exportDone').hidden, true);
});

test('page collection completion is explicit and resets when continuing, while pause and errors never show a full bar', () => {
  const {ui, $} = uiHarness();
  ui.setAccount('1000000001', '合成账号');
  for (const type of ['NEXT', 'PREPARE', 'STARTED']) ui.dispatch({type});
  ui.setSavedCount(57);
  assert.equal($('pageProgress').dataset.state, 'working');
  assert.equal($('pageProgress').getAttribute('aria-valuenow'), undefined);
  ui.dispatch({type:'SETTLED',outcome:'ready'});
  assert.equal($('pageProgress').hidden, false);
  assert.equal($('pageProgress').dataset.state, 'ready');
  assert.equal($('pageProgress').getAttribute('aria-valuenow'), '1');
  assert.equal($('stepTitle').textContent, '可以导出了');
  assert.equal($('wizardToExport').disabled, false);
  ui.dispatch({type:'OPEN_EXPORT'});
  ui.dispatch({type:'BACK'});
  assert.equal($('pageProgress').dataset.state, 'ready');
  for (const outcome of ['paused','error']) {
    ui.dispatch({type:'PREPARE'});
    assert.equal($('pageProgress').dataset.state, 'working');
    assert.equal($('pageProgress').getAttribute('aria-valuenow'), undefined);
    ui.dispatch({type:'STARTED'});
    ui.dispatch({type:'SETTLED',outcome});
    assert.equal($('pageProgress').hidden, true);
    assert.equal($('wizardToExport').disabled, false, 'saved content remains exportable');
    assert.equal($('stepTitle').textContent, outcome === 'paused' ? '采集已暂停' : '采集已中断');
  }
  ui.dispatch({type:'PREPARE'});
  ui.dispatch({type:'STARTED'});
  ui.setSavedCount(0);
  ui.dispatch({type:'SETTLED',outcome:'ready'});
  assert.equal($('pageProgress').hidden, true);
  assert.equal($('wizardToExport').disabled, true);
  assert.equal($('stepTitle').textContent, '暂未找到微博');
});

test('download verification gates the final state and other months return to export controls', () => {
  const {ui, $, sections} = uiHarness();
  ui.setSavedCount(2);
  for (const type of ['OPEN_EXPORT', 'EXPORTING']) ui.dispatch({type});
  ui.dispatch({type: 'DOWNLOAD', canConfirm: true});
  assert.equal($('confirmExport').hidden, false);
  assert.equal($('confirmExport').disabled, false);
  ui.dispatch({type: 'VERIFY'});
  assert.equal($('confirmExport').disabled, true);
  ui.dispatch({type: 'VERIFY_FAILED'});
  assert.equal($('exportDone').hidden, true);
  assert.equal($('confirmExport').disabled, false);
  ui.dispatch({type: 'VERIFY'});
  ui.dispatch({type: 'CONFIRMED', month: '2026-11'});
  assert.equal(sections.filter(section => !section.hidden).length, 1);
  assert.equal(sections[3].hidden, false);
  assert.equal($('exportReady').hidden, true);
  assert.equal($('exportDone').hidden, false);
  assert.equal($('doneMonth').textContent, '2026-11');
  ui.dispatch({type: 'NEXT_MONTH'});
  assert.equal($('exportReady').hidden, false);
  assert.equal($('exportDone').hidden, true);
  assert.equal($('confirmExport').hidden, true);
});

test('idle embedded panels close immediately and standalone views hide window controls', async () => {
  const standalone = uiHarness();
  assert.equal(standalone.$('panelClose').hidden, true);
  assert.equal(standalone.$('panelMinimize').hidden, true);
  const {$, messages} = uiHarness({embedded:true});
  assert.equal($('panelClose').hidden, false);
  await $('panelClose').click();
  assert.equal($('closePrompt').hidden, true);
  assert.equal(messages.filter(message => message.type === 'WOB_PANEL_CLOSE').length, 1);
});

test('closing during a task offers an explicit minimize or cancel without interrupting the task', async () => {
  const {ui, $, messages} = uiHarness({embedded:true});
  ui.setSavedCount(3);
  ui.dispatch({type:'OPEN_EXPORT'});
  ui.dispatch({type:'EXPORTING'});
  await $('panelClose').click();
  assert.equal($('closePrompt').hidden, false);
  assert.equal($('closeMinimize').focusCount, 1);
  assert.equal(messages.some(message => message.type === 'WOB_PANEL_CLOSE'), false);
  $('closeCancel').click();
  assert.equal($('closePrompt').hidden, true);
  assert.equal($('panelClose').focusCount, 1);
  await $('panelClose').click();
  await $('closeMinimize').click();
  assert.equal($('closePrompt').hidden, true);
  assert.equal(messages.filter(message => message.type === 'WOB_PANEL_MINIMIZE').length, 1);
  assert.equal(ui.state.phase, 'exporting');
  await $('panelClose').click();
  ui.dispatch({type:'EXPORT_FAILED'});
  assert.equal($('closePrompt').hidden, true);
  await $('panelClose').click();
  assert.equal(messages.filter(message => message.type === 'WOB_PANEL_CLOSE').length, 1);
});

test('a parent busy response opens the same prompt and action errors stay visible on export step', async () => {
  const busy = uiHarness({embedded:true,windowResponse:{ok:false,busy:true}});
  await busy.$('panelClose').click();
  assert.equal(busy.$('closePrompt').hidden, false);
  const failed = uiHarness({embedded:true,windowResponse:{ok:false,error:'请刷新微博后重试'}});
  failed.ui.setSavedCount(2);
  failed.ui.dispatch({type:'OPEN_EXPORT'});
  await failed.$('panelClose').click();
  assert.equal(failed.$('panelActionStatus').hidden, false);
  assert.match(failed.$('panelActionStatus').textContent, /刷新微博/);
});
