// 本地视觉验收使用独立模拟数据，不连接微博或读取浏览器扩展的数据。
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const extension = path.join(root, 'extension');
// 离线图片通过与扩展后台一致的消息协议返回，绝不请求占位 URL 所在的网站。
function previewBootstrap(version) {
  const query = new URLSearchParams(location.search), many = query.get('months') === '87', legacy = query.get('media') === 'legacy';
  const uid = legacy ? '1000000073' : many ? '1000000087' : '1000000002';
  const photoURL = 'https://wx1.sinaimg.cn/large/xiaowei-offline-preview-photo-v1.png';
  // 与真实 CDN 使用相同的 URL 校验规则，但素材完全在本页 Canvas 内生成。
  const faceURL = 'https://wx1.sinaimg.cn/emoticon/xiaowei-offline-preview-smile-v1.png';
  const legacyFaceURL = 'https://img.t.sinajs.cn/t4/appstyle/expression/ext/normal/offline-smile-v073.png';
  const retryPhotoURL = 'https://wx1.sinaimg.cn/large/xiaowei-offline-retry-v073.png';
  const state = window.previewState = {version, uid, connected: true, contextInvalidated: false, permissionGranted: true,
    downloadFails: false, downloadComplete: true, saveFiles: query.get('downloads') === '1', busy: 'idle',
    nextDownloadId: Date.now(), downloads: new Map(), lastFileURL: null, mediaRequests: 0, legacyFailure: legacy};
  const status = text => { document.getElementById('exportBridgeStatus').textContent = text; };
  const fixtures = new Map();
  function mediaFixture(url) {
    if (fixtures.has(url)) return fixtures.get(url);
    if (![photoURL, faceURL, legacyFaceURL, retryPhotoURL].includes(url)) throw new Error('离线预览没有这个图片素材，不会访问外网。');
    const canvas = document.createElement('canvas'), face = [faceURL, legacyFaceURL].includes(url);
    canvas.width = face ? 96 : 640; canvas.height = face ? 96 : 360;
    const ctx = canvas.getContext('2d');
    if (face) {
      ctx.fillStyle = '#FFC94A'; ctx.beginPath(); ctx.arc(48, 48, 43, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#59412E'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      for (const x of [29, 65]) { ctx.beginPath(); ctx.arc(x, 39, 8, Math.PI, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = '#6D4332'; ctx.beginPath(); ctx.arc(48, 51, 24, 0, Math.PI); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#FCFCFF'; ctx.fillRect(31, 51, 34, 7);
      ctx.fillStyle = '#69BEE9';
      for (const x of [15, 81]) { ctx.beginPath(); ctx.ellipse(x, 55, 7, 13, x < 48 ? .4 : -.4, 0, Math.PI * 2); ctx.fill(); }
    } else {
      const sky = ctx.createLinearGradient(0, 0, 0, 360); sky.addColorStop(0, '#DFD9F4'); sky.addColorStop(1, '#F4E8D8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#F3BC78'; ctx.beginPath(); ctx.arc(480, 86, 38, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9A97C0'; ctx.beginPath(); ctx.moveTo(0, 240); ctx.lineTo(155, 90); ctx.lineTo(330, 244); ctx.lineTo(450, 144); ctx.lineTo(640, 262); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#756EA3'; ctx.beginPath(); ctx.moveTo(0, 267); ctx.lineTo(220, 182); ctx.lineTo(420, 290); ctx.lineTo(640, 212); ctx.lineTo(640, 360); ctx.lineTo(0, 360); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#B7CBD8'; ctx.fillRect(0, 285, 640, 75);
      ctx.fillStyle = '#FFFFFF'; ctx.font = '18px sans-serif'; ctx.fillText('OFFLINE FIXTURE / XIAOWEI MEMORY', 24, 336);
    }
    const result = {ok: true, mime: 'image/png', base64: canvas.toDataURL('image/png').split(',')[1]};
    fixtures.set(url, result); return result;
  }
  function postAt(date, index) {
    const createdAt = date.toISOString(), month = createdAt.slice(0, 7), id = `Offline${month.replace('-', '')}`;
    return {uid, id, identitySource: 'desktop-permalink', url: `https://weibo.com/${uid}/${id}`, author: '离线示例账号',
      createdAt, dateRaw: `${month}-10 10:00`, text: `${month} 的离线记忆：秋日散步，变化好大！\u200B\u200B\u200B 👍🏽 👩‍👩‍👧‍👦 [笑cry]\n第 ${index + 1} 条合成记录，图片、表情和文字都仅用于本机测试。`,
      isRepost: false, repostText: '', repostUrl: '', images: [photoURL], emoticons: [{text: '[笑cry]', url: faceURL}], fullText: true};
  }
  const posts = many ? Array.from({length: 87}, (_, index) => postAt(new Date(Date.UTC(2019, 8 + index, 10, 2)), index)) :
    [postAt(new Date('2026-11-10T02:00:00.000Z'), 0), postAt(new Date('2026-10-10T02:00:00.000Z'), 1)];
  if (legacy) for (const post of posts) {
    post.images = [post.createdAt.startsWith('2026-11') ? retryPhotoURL.replace('https:', 'http:') : photoURL.replace('https:', '')];
    post.emoticons = [{text: '[笑cry]', url: legacyFaceURL.replace('https:', 'http:')}];
  }
  const repost = {...posts[0], id: 'OfflineRepost', url: `https://weibo.com/${uid}/OfflineRepost`,
    text: '这条合成转发应当被过滤。', isRepost: true, repostText: '示例转发正文', images: [], emoticons: []};
  window.previewAPI = {
    profileURL: () => state.connected ? `https://weibo.com/u/${uid}` : 'https://weibo.com/',
    scan: () => ({ok: true, posts: [...posts, repost], diagnostics: {pageUid: uid, pageName: '离线示例账号', restricted: '', cards: posts.length + 1, unparsed: 0}}),
    async exportMessage(message, exportFile) {
      if (message.type === 'WOB_EXPORT_PERMISSION') {
        status(`模拟后台图片授权：${state.permissionGranted ? '允许' : '拒绝'}`);
        return {ok: true, granted: state.permissionGranted};
      }
      if (message.type === 'WOB_EXPORT_MEDIA') {
        if (!state.permissionGranted) return {ok: false, error: '模拟：图片权限已拒绝'};
        if (message.url === retryPhotoURL && state.legacyFailure) return {ok: false, error: '离线模拟：图片读取失败（HTTP 404）'};
        try {
          const fixture = mediaFixture(message.url); state.mediaRequests++;
          status(`离线图片协议已返回 ${state.mediaRequests} 次合法 PNG；未访问外网。`);
          return fixture;
        } catch (error) { return {ok: false, error: error.message}; }
      }
      if (message.type === 'WOB_EXPORT_DOWNLOAD') {
        if (state.downloadFails) return {ok: false, error: '模拟：下载已取消，请重试'};
        // 保留生成器给出的原始 File/Blob；不重新 fetch 大 ZIP 或读入 arrayBuffer。
        // 生成与打包均使用真实代码，这里只模拟最后一次下载的回执。
        if (!exportFile || typeof exportFile.slice !== 'function' || !exportFile.size) return {ok: false, error: '离线预览未取得生成文件。'};
        const blob = exportFile, downloadId = ++state.nextDownloadId;
        const receipt = {downloadId, filename: message.filename, size: blob.size, state: 'in_progress', completeAt: Date.now() + 650};
        state.downloads.set(downloadId, receipt);
        const copyURL = URL.createObjectURL(blob), oldURL = state.lastFileURL; state.lastFileURL = copyURL;
        const link = document.getElementById('lastFile'); link.href = copyURL; link.download = message.filename;
        link.textContent = `下载最近生成的文件：${message.filename}`; link.hidden = false;
        const pdf = document.getElementById('pdfPreview');
        pdf.hidden = blob.type !== 'application/pdf';
        if (pdf.hidden) pdf.removeAttribute('src'); else pdf.src = copyURL;
        if (oldURL) URL.revokeObjectURL(oldURL);
        const list = document.getElementById('downloadReceipts'), row = document.createElement('li');
        row.textContent = `#${downloadId} · ${message.filename} · ${(blob.size / 1024 / 1024).toFixed(2)} MiB`;
        list.prepend(row); while (list.children.length > 12) list.lastElementChild.remove();
        document.getElementById('downloadSummary').textContent = `已收到 ${state.downloads.size} 次文件下载；${state.saveFiles ? '同时保存到浏览器下载目录' : '仅模拟回执，没有自动下载'}。多个月份统一为一个 ZIP。`;
        if (state.saveFiles) { const save = document.createElement('a'); save.href = copyURL; save.download = message.filename; document.body.append(save); save.click(); save.remove(); }
        status(`模拟后台已收到下载 #${downloadId}：${message.filename}`);
        return {ok: true, downloadId};
      }
      if (message.type === 'WOB_EXPORT_DOWNLOAD_STATE') {
        const receipt = state.downloads.get(message.downloadId);
        if (receipt?.state === 'in_progress') receipt.state = state.downloadFails ? 'interrupted' :
          !state.downloadComplete || Date.now() < receipt.completeAt ? 'in_progress' : 'complete';
        const downloadState = receipt?.state || 'unknown';
        status(`模拟后台下载 #${message.downloadId}：${downloadState}`);
        return {ok: true, state: downloadState};
      }
      return null;
    }
  };
  document.getElementById('fixtureMode').textContent = `当前：${posts.length} 个月 / ${posts.length} 条原创 + 1 条转发；模拟 UID ${uid}。图片为 Canvas 合成 PNG，正文包含零宽字符、👍🏽、👩‍👩‍👧‍👦、[笑cry]。`;
  if (legacy) document.getElementById('fixtureMode').textContent += ' 旧地址测试：HTTP / 协议相对图片与旧表情域名，11 月照片模拟失败，恢复后只需重试该月。';
  document.getElementById('fixturePhoto').src = `data:image/png;base64,${mediaFixture(photoURL).base64}`;
  const mode = document.getElementById('recordMode'); mode.textContent = many ? '切换 2 个月示例' : '切换 87 个月示例';
  const available = () => { if (['exporting', 'collecting'].includes(state.busy)) { status('请先暂停采集或等待当前导出完成，再切换示例。'); return false; } return true; };
  const legacyButton = document.createElement('button'); legacyButton.textContent = legacy ? '恢复旧图片读取' : '切换旧图片兼容示例';
  document.getElementById('seedRecords').parentElement.append(legacyButton);
  legacyButton.onclick = () => {
    if (!available()) return;
    if (!legacy) { const url = new URL(location.href); url.searchParams.set('media', 'legacy'); url.searchParams.set('months', '2'); location.href = url.href; return; }
    state.legacyFailure = !state.legacyFailure;
    legacyButton.textContent = state.legacyFailure ? '恢复旧图片读取' : '再次模拟旧图片失败';
    status(state.legacyFailure ? '11 月照片模拟 404；10 月正常。' : '旧图片已恢复。记录和月份快照保持不变，可重试未完成月份。');
  };
  mode.onclick = () => { if (!available()) return; const url = new URL(location.href); url.searchParams.set('months', many ? '2' : '87'); location.href = url.href; };
  const saveMode = document.getElementById('saveMode');
  const updateSaveMode = () => { saveMode.textContent = state.saveFiles ? '关闭自动下载（当前已开启）' : '开启自动下载（当前仅回执）'; };
  updateSaveMode(); saveMode.onclick = () => { state.saveFiles = !state.saveFiles; updateSaveMode(); };
  document.getElementById('seedRecords').onclick = async event => {
    if (!available()) return; const button = event.currentTarget; button.disabled = true;
    try {
      const [db, {savePostRecord}] = await Promise.all([import('/db.js'), import('/record-store.js')]);
      for (const post of posts) await savePostRecord(db, post);
      await db.put('settings', {format: 'pdf', images: true, from: '', to: '', autoScroll: false}, 'options');
      document.getElementById('seedStatus').textContent = `已载入 ${posts.length} 条原创。面板里点击“导出已有记录”，可跳过采集；本次只写入 localhost 的预览数据库。`;
      document.getElementById('weibo-obsidian-floating-panel')?.shadowRoot?.querySelector('iframe')?.contentWindow.location.reload();
    } catch (error) { document.getElementById('seedStatus').textContent = error.message; }
    finally { button.disabled = false; }
  };
  document.getElementById('reopen').onclick = () => {
    if (window.WOBFloatingPanel) { window.WOBFloatingPanel.expand(); return; }
    // 与工具栏再次 executeScript 一致，关闭后重新注入一个全新的浮窗。
    const script = document.createElement('script'); script.src = '/floating-panel.js';
    script.onload = script.onerror = () => script.remove(); document.body.append(script);
  };
  document.getElementById('sourceState').onclick = event => { state.connected = !state.connected; event.currentTarget.textContent = state.connected ? '模拟未连接' : '恢复个人主页'; };
  document.getElementById('contextState').onclick = event => { state.contextInvalidated = !state.contextInvalidated; event.currentTarget.textContent = state.contextInvalidated ? '恢复扩展连接' : '模拟扩展失效'; document.getElementById('contextStatus').textContent = state.contextInvalidated ? '扩展连接模拟：已失效，runtime.id 不可用，权限及下载消息将报失效错误。' : '扩展连接模拟：已恢复，可在当前模拟面板重试；真实扩展失效需要刷新微博。'; };
  document.getElementById('permissionState').onclick = event => { state.permissionGranted = !state.permissionGranted; event.currentTarget.textContent = state.permissionGranted ? '模拟拒绝图片权限' : '恢复允许图片权限'; };
  document.getElementById('downloadState').onclick = event => { state.downloadFails = !state.downloadFails; event.currentTarget.textContent = state.downloadFails ? '恢复正常下载' : '模拟下载失败'; };
  document.getElementById('downloadComplete').onclick = event => { state.downloadComplete = !state.downloadComplete; event.currentTarget.textContent = state.downloadComplete ? '模拟下载未完成' : '模拟下载已完成'; };
  window.addEventListener('beforeunload', () => { if (state.lastFileURL) URL.revokeObjectURL(state.lastFileURL); });
}

// 故意不提供 permissions/downloads，保证 iframe 实际经过后台兼容桥接与媒体协议。
function installMock() {
  const stale = () => { if (parent.previewState?.contextInvalidated) throw new Error('Extension context invalidated.'); };
  const blobs = new Map(), createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = createURL(blob); blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { blobs.delete(url); revokeURL(url); };
  window.chrome = {runtime: {
    get id() { return parent.previewState?.contextInvalidated ? undefined : 'preview'; },
    getManifest() { stale(); return {version: parent.previewState.version}; }, getURL: name => location.origin + '/' + name,
    onMessage: {addListener: fn => { window.previewListener = fn; }, removeListener: fn => { if (window.previewListener === fn) delete window.previewListener; }},
    sendMessage: async message => {
      stale();
      if (message.type === 'WOB_PANEL_CONTEXT') return {ok: true, tabId: 1};
      if (message.type.startsWith('WOB_EXPORT_')) return parent.previewAPI.exportMessage(message, blobs.get(message.url));
      if (message.type === 'WOB_PANEL_ACTIVITY') parent.previewState.busy = message.state;
      if (typeof parent.previewListener !== 'function') return {ok:false,error:'浮窗已关闭，请再次点击扩展图标。'};
      return new Promise(resolve => parent.previewListener(message, {id: 'preview'}, resolve));
    }
  }, tabs: {get: async () => ({id: 1, url: parent.previewAPI.profileURL()}),
    sendMessage: async (_id, message) => message.type === 'WOB_SCAN' ? parent.previewAPI.scan() : {ok: true}},
  scripting: {executeScript: async config => config.args ? [{result: {ok: true, json: {ok: 1, data: {list: []}}}}] : [{result: parent.previewAPI.profileURL()}]}};
}
const mock = `(${installMock.toString()})();`;
const version = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')).version;
const shell = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小微记忆 · 悬浮面板预览</title><style>
*{box-sizing:border-box}body{margin:0;background:#202024;color:#bdbdc7;font:15px/1.7 system-ui,-apple-system,sans-serif}header{height:66px;padding:18px 28px;border-bottom:1px solid #3c3c44;font-weight:650}.page{max-width:850px;margin:48px auto;padding:24px}.note{color:#a7a7b3;font-size:13px}.post{border:1px solid #3d3d46;border-radius:14px;padding:24px;margin:18px 0;background:#29292f}.post h2{font-size:18px;color:#e4e4e9}.tools{display:flex;gap:8px;flex-wrap:wrap}button{background:#41414b;border:1px solid #666671;border-radius:8px;padding:8px 12px;color:#f0f0f4;cursor:pointer}button:disabled{opacity:.5}a{color:#c0b3ff;overflow-wrap:anywhere}#fixturePhoto{width:min(100%,480px);border-radius:10px}#downloadReceipts{font:12px/1.6 ui-monospace,monospace;padding-left:20px;overflow-wrap:anywhere}#pdfPreview{border:1px solid #666671;border-radius:10px;width:100%;height:760px;margin-top:16px;background:#fff}[hidden]{display:none!important}@media(max-width:500px){.page{margin-top:380px;padding:12px}header{padding:16px}}
</style></head><body><header>微博页面 · 离线预览</header><main class="page"><p class="note">示例账号、图片和微博均为离线合成数据，不访问真实微博。PDF 与 ZIP 使用实际导出代码生成，默认只模拟下载回执。</p><div class="tools"><button id="recordMode">切换示例</button><button id="seedRecords">载入示例（跳过采集）</button><button id="saveMode">仅模拟下载回执</button></div><p class="note" id="fixtureMode"></p><p class="note" id="seedStatus">先载入示例，再从浮窗导出已有记录。选择单个月可在下方预览实际 PDF；全部月份会先逐月生成，最后统一打包为一个 ZIP。</p><div class="tools"><button id="reopen">再次点击扩展图标</button><button id="sourceState">模拟未连接</button><button id="contextState">模拟扩展失效</button><button id="permissionState">模拟拒绝图片权限</button><button id="downloadState">模拟下载失败</button><button id="downloadComplete">模拟下载未完成</button></div><p class="note" id="contextStatus">扩展连接模拟：正常；切换失效不会重新加载真实扩展。</p><p class="note" id="exportBridgeStatus">导出接口模拟：面板不提供 permissions / downloads。</p><article class="post"><h2>离线示例账号</h2><p>秋日散步，变化好大！👍🏽 👩‍👩‍👧‍👦 [笑cry]</p><img id="fixturePhoto" alt="离线合成的山水照片测试素材"></article><article class="post"><h2>生成结果</h2><p class="note" id="downloadSummary">尚未生成文件。仅保留最近一份文件的预览链接，避免测试页面累积内存。</p><a id="lastFile" hidden>下载最近生成的文件</a><ol id="downloadReceipts"></ol><iframe id="pdfPreview" title="最近生成的 PDF 预览" hidden></iframe></article></main><script>(${previewBootstrap.toString()})(${JSON.stringify(version)});${mock}</script><script src="/floating-panel.js"></script></body></html>`;

const server = http.createServer(async (req,res) => {
  try {
    const pathname = new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(shell); return; }
    if(pathname === '/adapter-check.html') {
      const fixture=await readFile(path.join(root,'tests/weibo-modern-dom.sanitized.html'),'utf8');
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline'");
      res.end(fixture.replace('</body>',`<button id="runAdapter">检查原创识别</button><pre id="adapterResult"></pre><script src="/content.js"></script><script>document.getElementById('runAdapter').onclick=()=>{const result=WOBAdapter.scan(document,'https://weibo.com/u/1000000001',Date.parse('2026-11-01T09:00:00Z'));document.getElementById('adapterResult').textContent=JSON.stringify(result,null,2)}</script></body>`));return;
    }
    if(!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(html|js|css|ttf|png|svg)$/.test(pathname)) { res.writeHead(404); res.end(); return; }
    const assetType={'.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml'}[path.extname(pathname)];
    if(assetType){res.setHeader('Content-Type',assetType);res.end(await readFile(path.join(extension,pathname.slice(1))));return;}
    let content = await readFile(path.join(extension,pathname.slice(1)),'utf8');
    // 仅预览环境开放 shadow root，便于可访问性工具检验 iframe；发布文件仍使用 closed。
    if(pathname === '/floating-panel.js') content=content.replace("mode: 'closed'", "mode: 'open'");
    if(pathname === '/dashboard.html') content=content.replace('<script type="module"',`<script>${mock}</script><script type="module"`);
    res.setHeader('Content-Type', pathname.endsWith('.js')?'application/javascript; charset=utf-8':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
    res.end(content);
  } catch { res.writeHead(404);res.end(); }
});
server.listen(4178,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4178'));
