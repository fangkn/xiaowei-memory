(() => {
  'use strict';
  // 重复点击工具栏只展开同一个 iframe，保留采集任务和未确认的导出状态。
  if (globalThis.WOBFloatingPanel) {
    globalThis.WOBFloatingPanel.expand();
    return;
  }
  // 扩展重新加载会创建新的隔离上下文，但旧浮窗 DOM 可能仍留在微博页面。
  // 仅清理本扩展或未标记的旧版浮窗，保留其他安装实例的面板。
  const panelId = 'weibo-obsidian-floating-panel';
  const extensionId = chrome.runtime.id;
  for (const previous of document.querySelectorAll(`[id="${panelId}"]`)) {
    if (!previous.dataset.extensionId || previous.dataset.extensionId === extensionId) previous.remove();
  }
  const host = document.createElement('div');
  host.id = panelId;
  host.dataset.extensionId = extensionId;
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:16px 16px auto auto!important;width:min(340px,calc(100% - 32px))!important;height:0!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font-family:system-ui,-apple-system,"PingFang SC",sans-serif}*{box-sizing:border-box}
    .window{position:relative;width:100%;height:min(var(--panel-height,280px),560px,75dvh);background:#FFFFFF;border:1px solid #E4E6EC;border-radius:14px;box-shadow:0 12px 40px #34394624,0 2px 8px #3439460d;overflow:hidden}
    iframe{display:block;width:100%;height:100%;border:0;background:#FFFFFF;color-scheme:light}
    .restore{display:none;align-items:center;gap:8px;min-height:36px;padding:7px 12px;border:1px solid #E4E6EC;border-radius:10px;background:#FFFFFF;color:#343946;font:600 12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;box-shadow:0 8px 32px #34394620;cursor:pointer;white-space:nowrap}
    .restore:hover{background:#EFEDFB}.restore:focus-visible{outline:3px solid #8B7CDD;outline-offset:3px}
    .dot{width:8px;height:8px;border-radius:50%;background:#B7AFDA;flex-shrink:0}.restore[data-busy=true] .dot{background:#6D5BD0}
    .activity{font-size:12px;color:#626C7D;font-weight:400}
    .collapsed .window{position:absolute;visibility:hidden;pointer-events:none}
    .collapsed .restore{display:flex;margin-left:auto}
    @media(max-width:500px){.window{max-height:calc(100dvh - 24px)}}
  `;
  const wrapper = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'window';
  const frame = document.createElement('iframe');
  frame.title = '小微记忆悬浮面板';
  frame.src = chrome.runtime.getURL('dashboard.html') + '?embedded=1';
  // iframe 使用扩展自身来源，页面样式不能影响控件，本地数据库仍属于原扩展。
  panel.append(frame);
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'restore';
  restore.setAttribute('aria-label', '展开小微记忆面板');
  restore.setAttribute('aria-expanded', 'false');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = '小微记忆';
  const activity = document.createElement('span');
  activity.className = 'activity';
  activity.textContent = '已就绪';
  restore.append(dot, label, activity);
  wrapper.append(panel, restore);
  shadow.append(style, wrapper);
  document.documentElement.append(host);
  let activityState = 'idle';

  function expand() {
    // 不重新挂载 iframe；移动已连接 iframe 会重建上下文并中断任务。
    wrapper.classList.remove('collapsed');
    restore.setAttribute('aria-expanded', 'true');
    frame.focus();
  }
  function minimize() {
    wrapper.classList.add('collapsed');
    restore.setAttribute('aria-expanded', 'false');
    restore.focus();
  }
  function close() {
    chrome.runtime.onMessage.removeListener(onMessage);
    host.remove();
    if (globalThis.WOBFloatingPanel === panelAPI) delete globalThis.WOBFloatingPanel;
  }
  restore.addEventListener('click', expand);
  function onMessage(message, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'WOB_PANEL_MINIMIZE') minimize();
    else if (message?.type === 'WOB_PANEL_CLOSE') {
      if (activityState !== 'idle') {
        sendResponse({ ok: false, busy: true, error: '任务正在进行，可以先最小化，任务会继续。' });
        return false;
      }
      sendResponse({ ok: true });
      close();
      return false;
    }
    else if (message?.type === 'WOB_PANEL_RESIZE' && Number.isFinite(message.height)) {
      panel.style.setProperty('--panel-height', `${Math.max(180, Math.min(720, message.height))}px`);
    } else if (message?.type === 'WOB_PANEL_ACTIVITY' && ['idle', 'collecting', 'exporting'].includes(message.state)) {
      activityState = message.state;
      activity.textContent = { idle: '已就绪', collecting: '采集中', exporting: '处理中' }[message.state];
      restore.dataset.busy = String(message.state !== 'idle');
    } else return false;
    sendResponse({ ok: true });
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  const panelAPI = { expand };
  globalThis.WOBFloatingPanel = panelAPI;
})();
