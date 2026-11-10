'use strict';

const title = document.getElementById('launcherTitle');
const description = document.getElementById('launcherDescription');
const actions = document.getElementById('launcherActions');
const openWeibo = document.getElementById('openWeibo');
const retryOpen = document.getElementById('retryOpen');
let busy = false;

function isWeiboPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['weibo.com', 'www.weibo.com'].includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function showGuide(heading, text, retry = false) {
  title.textContent = heading;
  description.textContent = text;
  retryOpen.hidden = !retry;
  actions.hidden = false;
}

function setBusy(value) {
  busy = value;
  openWeibo.disabled = value;
  retryOpen.disabled = value;
}

async function clearToolbar(tabId) {
  // 清理旧版遗留的感叹号；标签页关闭或工具栏 API 失败不妨碍正常引导。
  await Promise.allSettled([
    Promise.resolve().then(() => chrome.action.setBadgeText({tabId, text: ''})),
    Promise.resolve().then(() => chrome.action.setTitle({tabId, title: '打开小微记忆悬浮面板'})),
  ]);
}

async function initialize() {
  if (busy) return;
  setBusy(true);
  try {
    // 每次重试都重新取得用户当前标签页，不沿用已关闭或已导航的页面。
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const validTab = Number.isInteger(tab?.id) && tab.id >= 0;
    if (validTab) await clearToolbar(tab.id);
    if (!validTab || !isWeiboPage(tab.url)) {
      showGuide('先打开微博个人主页', '当前页面不是微博。打开微博并登录，点击自己的头像进入个人主页，再点击“小微记忆”图标。');
      return;
    }
    try {
      await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, files: ['floating-panel.js']});
      window.close();
    } catch {
      showGuide('面板暂时未能打开', '请刷新微博后重试。如果刚更新或重新加载过扩展，刷新页面后再点击图标即可。', true);
    }
  } catch {
    showGuide('暂时无法连接当前页面', '请重新点击扩展图标，或打开微博个人主页后再试。', true);
  } finally {
    setBusy(false);
  }
}

openWeibo.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    // 仅在用户主动点击后打开固定地址，保留原标签页。
    await chrome.tabs.create({url: 'https://weibo.com/', active: true});
    window.close();
  } catch {
    showGuide('暂时无法打开微博', '请再次点击“打开微博”，或手动在新标签页访问 weibo.com。');
  } finally {
    setBusy(false);
  }
});
retryOpen.addEventListener('click', initialize);
document.getElementById('closeLauncher').addEventListener('click', () => window.close());

initialize();
