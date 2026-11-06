import * as db from './db.js';
import {validProfile,postKey,isOriginalPost} from './model.js';
import {buildArchiveEntries,buildZip} from './archive.js';
import {normalizeApiPost,parseDirectoryResponse} from './history-data.js';
import {createHistoryTask,historyTaskKey,runHistoryTask,historyCoverage} from './history-runner.js';
import {requestFromTab,htmlToText,htmlToEmoticons} from './history-bridge.js';
import {savePostRecord} from './record-store.js';
import {selectMonthlyBatches,monthLedgerKey,verifyMonthlyArchive} from './monthly.js';
import {embedded,panelMessage,setupPanelUI} from './panel-ui.js';
import {isWizardBusy} from './wizard-state.js';
import {buildMonthlyPdf} from './monthly-pdf.js';
import {requestImagePermission,downloadExport,exportDownloadState,assertExtensionContext,normalizeExtensionError,requestExportMedia} from './browser-export.js';
import {exportJobKey,createExportJob,matchesExportJob,completedExportMonths,generatedExportMonths,runExportJob,cleanupExportJob} from './export-runner.js';
import {usableExportMedia,normalizeExportMediaURL} from './media-data.js';
import {mediaFailureDetails,enrichMediaFailures,formatExportFailures} from './media-diagnostics.js';
const $=id=>document.getElementById(id);
const panelUI=setupPanelUI();
let tabId=embedded?null:Number(new URL(location.href).searchParams.get('tab'))||null;
let uid='',running=false,exporting=false,generation=0,latestScan=null,pendingExport=null,historyTask=null,refreshVersion=0,exportRestoreVersion=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const status=text=>{$('status').textContent=text;if(panelUI.state.step===3)$('progressSummary').textContent=text};
const options=()=>({from:$('from').value,to:$('to').value,includeReposts:false,originalOnly:true,format:$('format').value==='markdown'?'markdown':'pdf',images:$('images').checked,autoScroll:$('scroll').checked});
async function saveOptions(){await db.put('settings',options(),'options')}
function activeControls(){const busy=running||exporting||isWizardBusy(panelUI.state);for(const id of ['connect','format','from','to','scroll','top','images','incremental','batch','historyFrom','historyTo','ownAccount','historyDirectory','historyRestart'])$(id).disabled=busy;panelUI.setActivity(running,exporting);}
async function send(type){if(!tabId)throw new Error('请在微博账号主页点击扩展图标。');return chrome.tabs.sendMessage(tabId,{type},{frameId:0});}
async function connect(){
  panelUI.dispatch({type:'CONNECTION',connected:false});
  if(!tabId)throw new Error('没有目标标签页。请回到微博账号主页，点击扩展图标。');
  let profileUrl;
  try {
    const tab = await chrome.tabs.get(tabId);
    profileUrl = tab.url;
    if (!profileUrl) {
      const [frame] = await chrome.scripting.executeScript({
        target: {tabId,frameIds:[0]},
        func: () => location.origin + location.pathname
      });
      profileUrl = frame?.result;
    }
  } catch {
    throw new Error('无法读取微博标签页。请刷新微博个人主页，再点击工具栏里的本扩展。');
  }
  if (!profileUrl) throw new Error('浏览器未返回原标签页地址。请从微博个人主页的浏览器工具栏重新打开本扩展。');
  if (!validProfile(profileUrl)) {
    throw new Error('当前是微博首页或其他页面，请先点击自己的头像进入个人主页。');
  }
  await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['content.js']});
  const scan=await send('WOB_SCAN');
  if(!scan?.ok)throw new Error(scan?.error||'页面识别失败，请刷新微博后重试。');
  if(scan.diagnostics?.restricted)throw new Error('页面提示登录、验证或访问限制，请在微博页面处理后重试。');
  if(!scan.diagnostics?.pageUid)throw new Error('没有可靠识别账号 UID，请使用数字 UID 主页。');
  if(uid!==String(scan.diagnostics.pageUid)){$('ownAccount').checked=false;pendingExport=null;$('confirmExport').disabled=true;}
  uid=String(scan.diagnostics.pageUid);$('uid').value=uid;latestScan=scan.diagnostics;
  panelUI.setAccount(uid,scan.diagnostics.pageName);
  await db.put('settings',{uid,name:scan.diagnostics.pageName||'',url:profileUrl,connectedAt:new Date().toISOString()},'target');
  status('');await refresh();
}
async function exportSelection({owner=uid,opts=options(),incremental=$('incremental').checked,posts=null}={}){
  const ledger=await db.get('settings',monthLedgerKey(owner,opts))||{};
  return selectMonthlyBatches(posts||await db.all('posts'),{uid:owner,fromMonth:opts.from,toMonth:opts.to,images:opts.images,originalOnly:true,format:opts.format,incremental,ledger});
}
async function refresh(){
  const version=++refreshVersion,owner=uid,opts=options(),all=await db.all('posts');
  const groups=await exportSelection({owner,opts,incremental:false,posts:all}),list=$('incremental').checked?await exportSelection({owner,opts,incremental:true,posts:all}):groups;
  if(version!==refreshVersion||owner!==uid)return;
  const originals=all.filter(p=>p.uid===owner&&isOriginalPost(p));
  panelUI.setSavedCount(originals.length);
  const posts=groups.flatMap(g=>g.posts),legacy=posts.filter(p=>!p.identitySource&&/^\d+$/.test(p.id)).length;
  $('legacyWarning').textContent=legacy?`当前范围有 ${legacy} 条旧版纯数字 ID 记录尚未确认与桌面永久链接的对应关系，可能重复；仅在接口给出精确 idstr 时归并，不猜测删除。`:'';
  $('total').textContent=posts.length;$('partial').textContent=posts.filter(p=>!p.fullText).length;$('unknown').textContent=originals.filter(p=>!p.createdAt).length;
  const old=$('batch').value;
  $('batch').replaceChildren(...list.map(batch=>{const el=document.createElement('option');el.value=batch.month;el.textContent=`${batch.month==='unknown'?'未知日期':batch.month} · ${batch.posts.length} 条原创`;return el}));
  if(list.length>1){const option=document.createElement('option');option.value='all';option.textContent=`全部月份 · ${list.length} 份${opts.format==='pdf'?' PDF':'月笔记'}`;$('batch').prepend(option)}
  if(!list.length){const empty=document.createElement('option');empty.value='';empty.textContent='没有待导出的月份';$('batch').append(empty)}
  else if(old==='all'&&list.length>1||list.some(g=>g.month===old))$('batch').value=old;
  if(list.length>1&&(!old||panelUI.state.step!==4))$('batch').value='all';
  $('diagnostics').textContent=JSON.stringify(latestScan||{},null,2);
  panelUI.render();
  if(panelUI.state.step===4&&!isWizardBusy(panelUI.state)&&!pendingExport)await restoreExportProgress();
}
async function scanOnce(seen=new Set()){
  await send('WOB_EXPAND');await sleep(700);
  const scan=await send('WOB_SCAN');if(!scan?.ok)throw new Error('微博页面读取失败。');
  if(scan.diagnostics?.restricted)throw new Error('微博要求登录/验证或限制了访问。已暂停，请到微博页面处理。');
  if(String(scan.diagnostics?.pageUid)!==uid)throw new Error('目标页面已切换账号，已暂停以避免混入其他内容。');
  let added=0,changed=0,other=0,reposts=0,discovered=0;
  for(const p of scan.posts){
    if(String(p.uid)!==uid){other++;continue}
    if(!p.id||!/^[a-zA-Z0-9_-]+$/.test(String(p.id)))continue;
    const key=postKey(p);if(!seen.has(key)){seen.add(key);discovered++}
    if(!isOriginalPost(p)){reposts++;continue}
    const old=await db.get('posts',key);
    const merged=await savePostRecord(db,p);
    if(!old)added++;else if(old.contentHash!==merged.contentHash)changed++;
  }
  latestScan={...scan.diagnostics,scannedAt:new Date().toISOString(),added,changed,otherAccountIgnored:other,repostsFiltered:reposts};
  await db.put('settings',{uid,status:'running',diagnostics:latestScan},`task:${uid}`);await refresh();return {updates:added+changed,discovered,reposts};
}
async function start(){
  if(running||exporting)return;
  await navigator.locks.request('weibo-backup-collection',{ifAvailable:true},async lock=>{
    if(!lock){status('另一个备份管理页正在采集，请先在那一页暂停。');return}
    running=true;generation++;const token=generation;panelUI.dispatch({type:'STARTED'});status('正在读取页面上的微博…');activeControls();let stagnant=0,round=0;const seen=new Set();
    try{
      while(running&&token===generation){
        const {updates,discovered,reposts}=await scanOnce(seen);round++;stagnant=updates||discovered?0:stagnant+1;
        if(!running||token!==generation)break;
        status(`已读取第 ${round} 屏 · 新增或更新 ${updates} 条原创${reposts?` · 跳过 ${reposts} 条转发`:''}`);
        if(!$('scroll').checked){status('本屏内容已保存，可以继续采集或导出。');break}
        if(stagnant>=6){status('暂时没有新微博，已暂停。可继续采集或导出已有内容。');break}
        await send('WOB_SCROLL');await sleep(2500+Math.random()*700);
      }
    }catch(e){status(`已暂停：${e.message}`)}finally{running=false;if($('status').textContent.startsWith('正在暂停'))status('进度已保存，可以继续采集，或导出已有记录。');await db.put('settings',{uid,status:'paused',diagnostics:latestScan,reason:$('status').textContent},`task:${uid}`)}
  });
}
function pause(){if(panelUI.state.phase!=='collecting')return;running=false;generation++;panelUI.dispatch({type:'STOPPING'});status('正在暂停，当前读取完成后保留进度。');activeControls();}
function usableMedia(item){return usableExportMedia(item)}
async function fetchMedia(url){
  return requestExportMedia(url);
}
async function prepareMonthExport(batch,exportOptions,exportUid){
  assertExtensionContext();
  const records=batch.posts,media=new Map(),failures=[];let size=0;
  // PDF 只呈现当前原创正文；Markdown 另外保留经过过滤的历史观察。
  const urls=[...new Set(records.flatMap(p=>[...(p.images||[]),...(exportOptions.format==='pdf'?(p.emoticons||[]).map(e=>e.url):(p.versions||[]).flatMap(v=>v.images||[]))]))];
  if(exportOptions.images){
    for(const [i,url] of urls.entries()){
      assertExtensionContext();
      $('exportStatus').textContent=`${batch.month==='unknown'?'未知日期':batch.month} · 准备图片 ${i+1}/${urls.length}`;
      try{
        if(size>=64*1024*1024)throw new Error('本月图片达到 64 MiB 上限，请取消图片后导出正文');
        let item=await db.get('media',url);
        if(item&&!usableMedia(item)){await db.remove('media',url);item=null}
        if(!item){item=await fetchMedia(url);try{await db.put('media',item)}catch{/* 缓存写入失败不影响本次导出。 */}}
        if(!usableMedia(item))throw new Error('图片缓存为空、格式无效或超限');
        if(size+item.bytes.length>64*1024*1024)throw new Error('本月图片超过 64 MiB 上限');
        media.set(url,item);size+=item.bytes.length;
      }catch(error){failures.push({url,reason:error.message})}
    }
  }
  assertExtensionContext();
  if(exportOptions.format==='pdf'){
    const result=await buildMonthlyPdf(batch,{media,images:exportOptions.images,onProgress:message=>{assertExtensionContext();$('exportStatus').textContent=typeof message==='string'?message:`正在生成 ${batch.month} PDF…`}});
    for(const url of result.failedMediaUrls||[]){try{await db.remove('media',url)}catch{/* 下次导出仍可继续重试。 */}}
    // 表情可有多个候选地址，以最终 PDF 的实际缺失为准，避免备用地址失效阻止完成。
    const failedImageCount=result.failedImageCount+(result.failedUnicodeEmojiCount||0);
    const unembedded=Array.isArray(result.attachmentFailures)?result.attachmentFailures:failedImageCount?mediaFailureDetails(records,(result.failedMediaUrls||[]).map(url=>({url,reason:'图片或表情未能解码或嵌入 PDF。'}))):[];
    const attachmentFailures=enrichMediaFailures(unembedded,failures,normalizeExportMediaURL);
    const failureReason=failedImageCount?[...new Set(attachmentFailures.map(item=>item.reason))].slice(0,3).join('；'):'';
    return {...result,failedImageCount,failureReason,attachmentFailures,extension:'pdf',mime:'application/pdf'};
  }
  const task=await db.get('settings',`task:${exportUid}`);
  const report={version:4,uid:exportUid,exportUnit:'month',snapshotMonth:batch.month,exportedAt:new Date().toISOString(),scope:exportOptions,imagesRequested:exportOptions.images,failures,failedImages:failures.length,fromDate:exportOptions.from,toDate:exportOptions.to,mode:exportOptions.images?'text-and-images':'text-only',saved:records.length,historyComplete:false,stopReason:task?.reason||'仅导出本机已采集的原创记录；未验证历史完整性'};
  const entries=buildArchiveEntries({posts:records,media,report});
  const integrity=verifyMonthlyArchive(entries,batch.month,records.length);
  const historyKey=await db.get('settings',`history:last:${exportUid}`),historical=historyKey?await db.get('settings',historyKey):null;
  if(historical){const coverage=historyCoverage(historical);coverage.note='最近一次年月任务的覆盖报告；不等于完整历史。导出已排除转发。';entries.push({name:'微博备份/history-coverage.json',data:JSON.stringify(coverage,null,2)})}
  const attachmentFailures=enrichMediaFailures(mediaFailureDetails(records,failures,{includeVersions:true}),failures,normalizeExportMediaURL);
  return {bytes:buildZip(entries),failedImageCount:Math.max(integrity.failedImageCount,failures.length),savedImageCount:integrity.savedImageCount,attachmentFailures,failureReason:[...new Set(attachmentFailures.map(item=>item.reason))].slice(0,3).join('；'),extension:'zip',mime:'application/zip'};
}
function renderExportFailures(job){
  const failures=Array.isArray(job?.failures)?job.failures:[],count=failures.reduce((sum,item)=>sum+(Array.isArray(item.attachments)?item.attachments.length:0),0);
  $('exportFailures').hidden=!failures.length;
  if(!failures.length)$('exportFailures').open=false;
  $('exportFailureSummary').textContent=`查看失败详情（${failures.length} 个月${count?` · ${count} 个附件地址`:''}）`;
  $('exportFailureList').textContent=formatExportFailures(failures);
}
async function restoreExportProgress(){
  if(!uid||panelUI.state.step!==4||isWizardBusy(panelUI.state))return;
  const owner=uid,opts=options(),month=$('batch').value,incremental=$('incremental').checked,version=exportRestoreVersion;
  const batches=(await exportSelection({owner,opts,incremental})).filter(item=>month==='all'||item.month===month);
  const job=await db.get('settings',exportJobKey(owner,opts));
  if(version!==exportRestoreVersion||uid!==owner||month!==$('batch').value||JSON.stringify(opts)!==JSON.stringify(options())||incremental!==$('incremental').checked||panelUI.state.step!==4||isWizardBusy(panelUI.state)||job?.confirmed||!matchesExportJob(job,owner,opts,batches))return;
  const generated=generatedExportMonths(job),ready=[...generated.values()].filter(item=>!item.failedImageCount).length;
  renderExportFailures(job);
  renderExportProgress({total:batches.length,generated:generated.size,ready,completed:0,failedMonths:job.failures.length,phase:job.failures.length?'partial':'preparing'});
  $('export').dataset.resume='true';
  $('exportStatus').textContent=`已找到上次导出任务，保留 ${ready} / ${batches.length} 个月的完整生成结果。点击“继续导出”后会检查并复用，继续处理未完成月份。`;
  panelUI.render();
}
function renderExportProgress(progress){
  const total=Math.max(0,progress.total||0),completed=Math.min(total,Math.max(0,progress.completed||0));
  const generated=Math.min(total,Math.max(0,progress.generated||0)),ready=Math.min(total,Math.max(0,progress.ready??generated));
  const failed=Array.isArray(progress.failedMonths)?progress.failedMonths.length:Number(progress.failedMonths)||0;
  const packing=progress.phase==='packing',downloading=progress.phase==='downloading',complete=progress.phase==='complete';
  const packedRatio=packing&&progress.totalBytes?Math.min(1,progress.packedBytes/progress.totalBytes):0;
  const work=complete?total+2:Math.min(total+1,ready+(downloading?1:packedRatio));
  $('exportProgressInfo').hidden=false;
  $('exportProgress').max=Math.max(1,total+2);$('exportProgress').value=work;
  $('exportProgressLabel').textContent=complete?`已完成 ${completed} / ${total} 个月`:`已生成 ${generated} / ${total} 个月${failed?` · ${failed} 个月待重试`:''}`;
  $('exportProgressPercent').textContent=failed&&progress.phase==='partial'?'待重试':`${total?Math.floor(work/(total+2)*100):0}%`;
  $('exportProgress').setAttribute('aria-valuetext',$('exportProgressLabel').textContent);
  const month=progress.currentMonth==='unknown'?'未知日期':progress.currentMonth;
  const reuseNote=progress.reused?`已复用 ${progress.reused} 个月。`:'';
  $('exportProgressDetail').textContent=reuseNote+(packing?`正在合成一个 ZIP${progress.totalBytes?` · ${Math.floor(packedRatio*100)}%`:''}…`:
    downloading?'正在下载最终文件，请保留本页…':complete?'所有月份均已保存，请打开文件核对。':progress.phase==='partial'?'完整月份的生成结果已保留，只需重试未完成内容。':
    month?`正在生成 ${month} 的文件…`:'正在检查已有生成结果…');
}
function resetExportProgress(){exportRestoreVersion++;$('exportProgressInfo').hidden=true;$('export').dataset.resume='false';renderExportFailures(null);}
async function withExportLock(operation){
  return navigator.locks.request('xiaowei-memory-export',{ifAvailable:true},lock=>{
    if(!lock)throw new Error('另一个小微记忆浮窗正在导出，请等待它完成后重试。');
    return operation();
  });
}
async function doExport(){
  if(exporting||running||isWizardBusy(panelUI.state)||panelUI.state.step!==4)return;if(!uid)throw new Error('请先识别微博账号。');
  const exportOptions=options(),exportUid=uid,exportMonth=$('batch').value,incrementalMode=$('incremental').checked;
  if(!exportMonth)throw new Error('没有待导出的原创微博，可调整月份或先采集内容。');
  const restart=panelUI.state.phase==='downloaded'&&panelUI.state.canConfirm;
  if(panelUI.dispatch({type:'EXPORTING'}).phase!=='exporting')return;
  let job=null;
  exporting=true;exportRestoreVersion++;pendingExport=null;status('');renderExportFailures(null);$('exportStatus').textContent='正在整理原创微博…';activeControls();
  try{
    assertExtensionContext();
    // 在点击事件的激活期请求可选图片权限。
    const permission=exportOptions.images?requestImagePermission():Promise.resolve(true);
    if(!await permission)throw new Error('未获得新浪图片读取权限。可以取消“包含图片”后导出正文。');
    await withExportLock(async()=>{
    const batches=(await exportSelection({owner:exportUid,opts:exportOptions,incremental:incrementalMode})).filter(g=>exportMonth==='all'||g.month===exportMonth);
    if(!batches.length)throw new Error('没有待导出的原创微博，请调整月份或先采集内容。');
    const jobKey=exportJobKey(exportUid,exportOptions),previous=await db.get('settings',jobKey);
    const reuse=!restart&&!previous?.confirmed&&matchesExportJob(previous,exportUid,exportOptions,batches);
    if(!reuse&&previous?.version===2){try{await cleanupExportJob(previous)}catch{/* 新任务不会依赖旧临时文件。 */}}
    job=reuse?previous:createExportJob(exportUid,exportOptions,batches);
    await runExportJob({job,batches,options:exportOptions},{
      prepareMonth:batch=>prepareMonthExport(batch,exportOptions,exportUid),
      downloadFile:downloadExport,downloadState:exportDownloadState,
      saveJob:value=>db.put('settings',value,jobKey),assertContext:assertExtensionContext,sleep,
      createObjectURL:blob=>URL.createObjectURL(blob),revokeObjectURL:url=>URL.revokeObjectURL(url),
      onProgress:progress=>{renderExportProgress(progress);if(progress.phase==='packing')$('exportStatus').textContent='各月文件已生成，正在统一打包…';if(progress.phase==='downloading')$('exportStatus').textContent='正在保存最终文件，请选择下载位置。';}
    });
    const completed=completedExportMonths(job),snapshots=[...completed.values()],hasFailures=completed.size!==batches.length;
    const downloadIds=[...new Set(snapshots.map(item=>item.downloadId))];
    const label=batches.length>1?`${batches.length} 份月度${exportOptions.format==='pdf'?' PDF':'笔记'}`:batches[0].month;
    pendingExport={uid:exportUid,month:label,ledgerKey:monthLedgerKey(exportUid,exportOptions),batches:snapshots.map(({month,revision})=>({month,revision})),downloadIds,downloadId:downloadIds[0],hasFailures,jobKey,jobStamp:job.stamp};
    $('export').dataset.resume=String(hasFailures);
    panelUI.dispatch({type:'DOWNLOAD',canConfirm:!hasFailures});
    renderExportFailures(job);
    const failed=job.failures?.slice(0,3).map(item=>`${item.month}：${item.reason}`).join('\n');
    $('exportStatus').textContent=hasFailures?`部分月份或附件未能完成，完整月份的生成结果已保留。点击“重试未完成月份”可继续。\n${failed||''}`:
      batches.length>1?`已下载一个 ZIP，包含 ${batches.length} 个月的独立文件。请解压核对后确认。`:'文件已下载，请打开核对后确认。';
    });
  }catch(error){
    let normalized=normalizeExtensionError(error);
    if(job){
      renderExportFailures(job);
      const count=[...generatedExportMonths(job).values()].filter(item=>!item.failedImageCount).length;$('export').dataset.resume='true';
      if(normalized.code!=='EXTENSION_CONTEXT_INVALIDATED')normalized=new Error(`${normalized.message}\n已保留 ${count} / ${job.plan.length} 个月的完整生成结果。可点击“继续导出”重试。`);
    }
    panelUI.dispatch({type:'EXPORT_FAILED'});$('exportStatus').textContent=normalized.message;throw normalized;
  }finally{exporting=false;activeControls()}
}
async function confirmExport(){
  if(!pendingExport||isWizardBusy(panelUI.state))return;
  if(pendingExport.hasFailures)throw new Error('仍有月份、图片或表情未完成，不能标记为成功导出');
  if(panelUI.dispatch({type:'VERIFY'}).phase!=='verifying')return;
  activeControls();
  try{
    for(const id of pendingExport.downloadIds||[pendingExport.downloadId]){
      const downloadState=await exportDownloadState(id);
      if(downloadState!=='complete')throw new Error('浏览器尚未确认文件下载完成，请稍后重试。');
    }
    if(pendingExport.uid!==uid)throw new Error('账号已变化，请重新导出。');
    const key=pendingExport.ledgerKey||monthLedgerKey(uid),snapshots=pendingExport.batches||[pendingExport];
    const ledger=await db.get('settings',key)||{};
    for(const snapshot of snapshots)ledger[snapshot.month]=snapshot.revision;
    await db.put('settings',ledger,key);
    if(pendingExport.jobKey){const job=await db.get('settings',pendingExport.jobKey);if(job?.stamp===pendingExport.jobStamp){await db.put('settings',{...job,confirmed:true},pendingExport.jobKey);try{await cleanupExportJob(job)}catch{/* 下载及记账已完成，临时文件清理失败不回退完成状态。 */}}}
    const month=pendingExport.month,exportedMonths=new Set(snapshots.map(snapshot=>snapshot.month));
    await refresh();
    pendingExport=null;
    $('wizardAnother').hidden=![...$('batch').options].some(option=>option.value&&option.value!=='all'&&!exportedMonths.has(option.value));
    panelUI.dispatch({type:'CONFIRMED',month});status('');
  }catch(error){const normalized=normalizeExtensionError(error);panelUI.dispatch({type:'VERIFY_FAILED'});$('exportStatus').textContent=normalized.message;throw normalized}finally{activeControls()}
}
function assertOwnAccount(){
  if(!uid||!tabId)throw new Error('请先在数字 UID 微博主页点击扩展并识别账号。');
  if(!$('ownAccount').checked)throw new Error('请确认这是自己的账号，并同意使用当前登录态只读查询。');
}
function renderHistorySummary(task){
  if(!task)return;
  const total=task.months.length,walked=task.months.filter(m=>m.status==='range-traversed-unverified').length;
  const issues=task.months.reduce((n,m)=>n+(m.unknownDateIds?.length||0)+(m.outOfRangeIds?.length||0)+(m.incompleteIds?.length||0),0);
  $('historySummary').textContent=`已记录空页证据的月份 ${walked} / ${total} · 待核查项目 ${issues}（可能涉及同一条微博） · 仅表示所选范围的接口遍历进度`;
  $('historyProgress').max=Math.max(total,1);$('historyProgress').value=walked;
}
async function showHistory(){
  const key=await db.get('settings',`history:last:${uid}`);historyTask=key?await db.get('settings',key):null;
  renderHistorySummary(historyTask);
  $('historyReport').textContent=historyTask?JSON.stringify(historyCoverage(historyTask),null,2):'尚无任务';
  if(historyTask)$('historyStatus').textContent=`任务 ${historyTask.startMonth} 至 ${historyTask.endMonth}：${historyTask.stopReason||historyTask.status}`;
}
async function readDirectory(){
  assertOwnAccount();if(running||exporting||isWizardBusy(panelUI.state))return;exporting=true;activeControls();
  try{const json=await requestFromTab(tabId,'directory',{uid});const months=parseDirectoryResponse(json);const result={uid,readAt:new Date().toISOString(),months,note:'仅供参考，不能据此跳过未列出的月份。'};await db.put('settings',result,`history:directory:${uid}`);$('historyReport').textContent=JSON.stringify(result,null,2);$('historyStatus').textContent=months.length?`目录列出 ${months.length} 个月，最早 ${months[0]}，最晚 ${months.at(-1)}。请自己确认起止年月。`:'目录没有提供月份；这不表示没有历史。请自行填写起止年月。';status($('historyStatus').textContent)}finally{exporting=false;activeControls()}
}
async function startHistory(){
  assertOwnAccount();if(running||exporting)return;
  const ownerUid=uid,sourceTabId=tabId;
  const proposed=createHistoryTask(ownerUid,$('historyFrom').value,$('historyTo').value);
  const key=historyTaskKey(proposed);let existing=await db.get('settings',key);
  if($('historyRestart').checked&&existing){await db.put('settings',existing,`${key}:previous:${existing.updatedAt}`);existing=null}
  if(existing?.status==='range-traversed-unverified'){panelUI.dispatch({type:'STARTED'});await showHistory();status('这段范围已有采集记录，尚未核验完整性。可以导出，或重新选择范围后核查。');return}
  await navigator.locks.request('weibo-backup-collection',{ifAvailable:true},async lock=>{
    if(!lock){status('另一管理页正在采集，请先暂停。');return}
    if(uid!==ownerUid||tabId!==sourceTabId||!$('ownAccount').checked)throw new Error('账号或确认状态已变化，请重新确认后开始。');
    running=true;generation++;const token=generation;panelUI.dispatch({type:'STARTED'});status('正在读取所选月份…');activeControls();
    try{
      await db.put('settings',{from:proposed.startMonth,to:proposed.endMonth},'history:range');
      historyTask=await runHistoryTask(existing||proposed,{
        request:(kind,params)=>requestFromTab(sourceTabId,kind,params),
        normalize:(raw,owner)=>normalizeApiPost(raw,owner,htmlToText,htmlToEmoticons),toText:htmlToText,toEmoticons:htmlToEmoticons,
        shouldIncludePost:isOriginalPost,
        savePost:p=>savePostRecord(db,p),
        saveTask:async task=>{await db.put('settings',task,historyTaskKey(task));await db.put('settings',historyTaskKey(task),`history:last:${ownerUid}`)},
        shouldPause:()=>!running||generation!==token,wait:sleep,
        onProgress:task=>{historyTask=task;renderHistorySummary(task);const current=task.months[task.activeMonth];$('historyStatus').textContent=task.status==='running'?`正在读取 ${current?.key||'范围末尾'} · 第 ${current?.page||'-'} 页`:task.stopReason;status($('historyStatus').textContent);$('historyReport').textContent=JSON.stringify(historyCoverage(task),null,2);refresh().catch(error=>status(error.message))}
      });status(historyTask.status==='range-traversed-unverified'?'所选月份已查询，可以导出已有记录。完整性尚未核验。':historyTask.stopReason);await refresh();
    }finally{running=false}
  });
}
async function beginBackup(){
  if(running||exporting||isWizardBusy(panelUI.state))return;
  const mode=panelUI.state.mode,confirmedUid=uid;
  if(mode==='history'){assertOwnAccount();createHistoryTask(uid,$('historyFrom').value,$('historyTo').value);}
  if(panelUI.dispatch({type:'PREPARE'}).phase!=='preparing')return;
  activeControls();status('正在连接微博…');
  try{
    await connect();
    if(uid!==confirmedUid){panelUI.dispatch({type:'SETTLED'});panelUI.dispatch({type:'RESET'});throw new Error('微博页面的账号已切换，请重新确认账号后再备份。');}
    pendingExport=null;
    $('from').value=mode==='history'?$('historyFrom').value:'';
    $('to').value=mode==='history'?$('historyTo').value:'';
    await saveOptions();
    if(mode==='history')await startHistory();else await start();
  }finally{
    panelUI.dispatch({type:'SETTLED'});activeControls();
    if(!panelUI.state.connected)panelUI.dispatch({type:'BACK'});
    await refresh();
  }
}
function openExport(){
  if(running||exporting||isWizardBusy(panelUI.state)||!panelUI.state.savedCount)return;
  pendingExport=null;resetExportProgress();$('exportStatus').textContent='';status('');panelUI.dispatch({type:'OPEN_EXPORT'});
  return restoreExportProgress();
}
function reportError(error){const normalized=normalizeExtensionError(error);if(panelUI.state.step===4){const output=$('exportStatus');output.textContent=normalized.message;output.scrollIntoView({block:'nearest'});}else status(normalized.message);console.error(normalized)}
function on(id,fn){$(id).addEventListener('click',()=>{try{Promise.resolve(fn()).catch(reportError)}catch(error){reportError(error)}})}
on('connect',async()=>{await connect();$('ownAccount').checked=false;await showHistory()});on('pause',pause);on('export',doExport);on('confirmExport',confirmExport);
on('historyDirectory',readDirectory);
on('wizardNext',()=>{if(exporting)return;status('');panelUI.dispatch({type:'NEXT'})});
on('wizardBack',()=>{status('');panelUI.dispatch({type:'BACK'})});
on('wizardStart',beginBackup);on('wizardResume',beginBackup);
on('wizardToExport',openExport);on('wizardLocalExport',openExport);
on('wizardReselect',()=>{status('');panelUI.dispatch({type:'RESELECT'})});
on('wizardExportBack',()=>{pendingExport=null;status('');panelUI.dispatch({type:'BACK'})});
on('wizardRestart',()=>{pendingExport=null;status('');panelUI.dispatch({type:'RESET'})});
on('wizardAnother',()=>{const next=[...$('batch').options].find(option=>option.value&&option.value!==panelUI.state.month);if(next)$('batch').value=next.value;resetExportProgress();$('exportStatus').textContent='';panelUI.dispatch({type:'NEXT_MONTH'})});
on('top',async()=>{if(!uid)await connect();await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:()=>window.scrollTo({top:0,behavior:'instant'})});status('已回到顶部。点击开始检查新增；已有内容自动去重。')});
for(const id of ['format','from','to','images','scroll','incremental','batch'])$(id).addEventListener('change',()=>{pendingExport=null;resetExportProgress();panelUI.dispatch({type:'INVALIDATE_DOWNLOAD'});saveOptions().then(refresh).catch(reportError)});
window.addEventListener('beforeunload',e=>{if(running||exporting){e.preventDefault();e.returnValue=''}});
async function initialize() {
  let sourceError='';
  if(embedded){
    try{
      const source=await panelMessage({type:'WOB_PANEL_CONTEXT'});
      if(!source?.ok||!Number.isInteger(source.tabId))throw new Error(source?.error||'无法连接微博，请刷新后再次点击扩展。');
      tabId=source.tabId;
    }catch(error){sourceError=error.message;}
  }
  const opts = await db.get('settings', 'options');
  if (opts) {
    $('format').value = opts.format==='markdown'?'markdown':'pdf';
    $('from').value = (opts.from || '').slice(0, 7);
    $('to').value = (opts.to || '').slice(0, 7);
    $('images').checked = opts.images !== false;
    $('scroll').checked = opts.autoScroll !== false;
  }
  const range = await db.get('settings', 'history:range');
  $('historyFrom').value = range?.from || '';
  $('historyTo').value = range?.to || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);

  let message = sourceError || '请从微博个人主页点击浏览器工具栏中的本扩展。';
  if (tabId) {
    try {
      await connect();
      await showHistory();
      return;
    } catch (error) {
      message = error.message;
    }
  }
  const target = await db.get('settings', 'target');
  if (target) {
    uid = target.uid;
    $('uid').value = uid;
    panelUI.setAccount(uid,target.name,true);
    const task = await db.get('settings', `task:${uid}`);
    latestScan = task?.diagnostics;
    message += ' 已有的本机记录仍可导出。';
    await showHistory();
  }
  status(message);
  await refresh();
}

const main = document.querySelector('main');
main.inert = true;
status('正在识别来源标签页…');
initialize().catch(error => status(error.message)).finally(() => { main.inert = false;activeControls(); });
