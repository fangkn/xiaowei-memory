import {dateParts} from './dates.js';
import {exportRevision,isOriginalPost} from './model.js';
export const MONTH_LEDGER_VERSION=3;
function exportScope({format='markdown',originalOnly=false}={}){
  if(!['markdown','pdf'].includes(format))throw new Error('不支持的导出格式');
  return {format,originalOnly:originalOnly===true};
}
export function monthLedgerKey(uid,options={}){
  const {format,originalOnly}=exportScope(options),base=`exported-months:v${MONTH_LEDGER_VERSION}`;
  return format==='markdown'&&!originalOnly?`${base}:${uid}`:`${base}:${format}:${originalOnly?'original':'all'}:${uid}`;
}
export function beijingMonth(post){return dateParts(post.createdAt)?.month||'unknown'}
function validMonth(value){return !value||/^\d{4}-(0[1-9]|1[0-2])$/.test(value)}
export function groupSavedMonths(posts,uid,{originalOnly=false}={}){
  const groups=new Map();
  for(const post of posts){
    if(post.uid!==String(uid)||originalOnly&&!isOriginalPost(post))continue;
    const month=beijingMonth(post);if(!groups.has(month))groups.set(month,[]);
    // Do not mutate the database snapshot. Exclude obsolete quote-marked
    // observations from an original-only Markdown history file as well.
    const item=originalOnly?{...post,versions:(Array.isArray(post.versions)?post.versions:[]).filter(isOriginalPost)}:post;
    groups.get(month).push(item);
  }
  return [...groups].sort(([a],[b])=>a==='unknown'?1:b==='unknown'?-1:a.localeCompare(b)).map(([month,items])=>({uid:String(uid),month,posts:items.sort((a,b)=>((Number.isFinite(Date.parse(a.createdAt))?Date.parse(a.createdAt):0)-(Number.isFinite(Date.parse(b.createdAt))?Date.parse(b.createdAt):0))||a.id.localeCompare(b.id))}));
}
export async function monthlyRevision(batch,images=false,options={}){
  // v3 never reuses the per-post ledger. Membership, all current bodies,
  // retained observations, order/date and media mode belong to one snapshot.
  const {format,originalOnly}=exportScope(options);
  const values=[MONTH_LEDGER_VERSION,batch.uid,batch.month,images?'images':'text',batch.posts.map(p=>[p.id,p.createdAt||null,exportRevision(p,images)])];
  // Retain the legacy default while keeping PDF and original-only receipts separate.
  if(format!=='markdown'||originalOnly)values.push(format,originalOnly?'original':'all');
  const data=JSON.stringify(values);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function selectMonthlyBatches(posts,{uid,fromMonth='',toMonth='',images=false,incremental=false,ledger={},originalOnly=false,format='markdown'}){
  if(!validMonth(fromMonth)||!validMonth(toMonth)||fromMonth&&toMonth&&fromMonth>toMonth)throw new Error('导出月份范围无效，请使用 YYYY-MM，起始不晚于结束。');
  const scope=exportScope({format,originalOnly});
  const result=[];
  for(const batch of groupSavedMonths(posts,uid,scope)){
    if(batch.month!=='unknown'&&((fromMonth&&batch.month<fromMonth)||(toMonth&&batch.month>toMonth)))continue;
    const revision=await monthlyRevision(batch,images,scope);
    if(!incremental||ledger[batch.month]!==revision)result.push({...batch,revision});
  }
  return result;
}

export function verifyMonthlyArchive(entries,month,expectedCount){
  const entry=entries.find(e=>e.name==='微博备份/manifest.json');
  if(!entry||typeof entry.data!=='string')throw new Error('归档缺少完整性清单，不能标记导出成功');
  const manifest=JSON.parse(entry.data);
  if(manifest.mainNoteCount!==1||manifest.months?.length!==1||manifest.months[0].month!==month||manifest.exportedPostCount!==expectedCount)throw new Error('归档月份或条数与整月快照不一致，已阻止不完整导出');
  if(!Number.isSafeInteger(manifest.failedImageCount)||manifest.failedImageCount<0||!Number.isSafeInteger(manifest.savedImageCount)||manifest.savedImageCount<0)throw new Error('附件完整性清单无效');
  return {failedImageCount:manifest.failedImageCount,savedImageCount:manifest.savedImageCount};
}
