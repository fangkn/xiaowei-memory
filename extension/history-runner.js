import {createMonthPlan,parseSearchResponse,parseLongTextResponse} from './history-data.js';
export const HISTORY_VERSION=1;
export function createHistoryTask(uid,startMonth,endMonth,now=Date.now()){
  return {schemaVersion:HISTORY_VERSION,uid:String(uid),startMonth,endMonth,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),status:'ready',activeMonth:0,requests:0,allHistoryGuaranteed:false,months:createMonthPlan(uid,startMonth,endMonth,now).map(m=>({...m,status:'pending',pages:[],emptyEvidence:[],signatures:[],unknownDateIds:[],outOfRangeIds:[],incompleteIds:[],failure:null})),stopReason:'尚未开始'};
}
export function historyTaskKey(task){return `history:${task.uid}:${task.startMonth}:${task.endMonth}`}
const stamp=()=>new Date().toISOString();
async function hashIds(ids){const bytes=new TextEncoder().encode(ids.slice().sort().join('|'));const out=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(out)].map(n=>n.toString(16).padStart(2,'0')).join('')}
export function historyCoverage(task){
  return {schemaVersion:1,mode:'experimental-month-history',uid:task.uid,startMonth:task.startMonth,endMonth:task.endMonth,status:task.status,stopReason:task.stopReason,allHistoryGuaranteed:false,createdAt:task.createdAt,updatedAt:task.updatedAt,requests:task.requests,months:task.months.map(m=>({month:m.key,status:m.status,nextPage:m.page,pages:m.pages,emptyEvidence:m.emptyEvidence,unknownDateIds:m.unknownDateIds,outOfRangeIds:m.outOfRangeIds,incompleteIds:m.incompleteIds||[],failure:m.failure}))};
}
/** At-least-once processing: only advance after every post is durable. */
export async function runHistoryTask(input,deps){
  const task=structuredClone(input);if(task.schemaVersion!==HISTORY_VERSION)throw new Error('历史任务版本不支持');
  const check=()=>{if(deps.shouldPause?.())throw Object.assign(new Error('用户暂停；当前页不会跳过'),{code:'USER_PAUSED'})};
  const persist=async()=>{task.updatedAt=stamp();await deps.saveTask(task);deps.onProgress?.(task)};
  const request=async(kind,params)=>{check();if(task.requests>=10000)throw Object.assign(new Error('达到单任务 10000 次请求安全上限，需人工核查覆盖报告'),{code:'REQUEST_LIMIT'});await deps.wait(3000);check();task.requests++;await persist();check();const result=await deps.request(kind,{uid:task.uid,...params});check();return result};
  task.status='running';task.stopReason='';await persist();
  try{
    while(task.activeMonth<task.months.length){
      check();const month=task.months[task.activeMonth];month.status='running';month.failure=null;
      if(month.page>1000)throw Object.assign(new Error('单月达到 1000 页安全上限，未证明完整'),{code:'PAGE_LIMIT'});
      const response=await request('search',{page:month.page,starttime:month.starttime,endtime:month.endtime});
      const {list,total}=parseSearchResponse(response);
      if(!list.length){
        month.emptyEvidence.push({page:month.page,at:stamp(),reportedTotal:total});
        // Persist first empty evidence but keep the same page. Never treat a
        // missing list, error JSON or limit response as an empty page.
        await persist();check();
        if(month.emptyEvidence.filter(e=>e.page===month.page).length<2)continue;
        month.status='range-traversed-unverified';month.failure=null;task.activeMonth++;await persist();continue;
      }
      month.emptyEvidence=month.emptyEvidence.filter(e=>e.page!==month.page);
      const posts=list.map(raw=>deps.normalize(raw,task.uid));
      if(posts.some(p=>!p||p.uid!==task.uid))throw Object.assign(new Error('本页含不能可靠识别的记录，保留当前页等待核查'),{code:'POST_SCHEMA'});
      const signature=await hashIds(posts.map(p=>p.id));check();
      if(month.signatures.includes(signature))throw Object.assign(new Error('接口重复返回已读页，可能忽略页码或受到限制；已暂停'),{code:'REPEATED_PAGE'});
      let saved=0,skipped=0,unknown=0,outside=0;
      for(const post of posts){
        check();
        const time=Date.parse(post.createdAt||'');
        if(!Number.isFinite(time)){if(!month.unknownDateIds.includes(post.id))month.unknownDateIds.push(post.id);unknown++}
        else if(time<month.starttime*1000||time>(month.endtime+1)*1000-1){if(!month.outOfRangeIds.includes(post.id))month.outOfRangeIds.push(post.id);outside++}
        // Filtering must not conceal an ignored date range or turn a repost-only
        // page into empty evidence. It also avoids requesting excluded long text.
        const include=deps.shouldIncludePost?await deps.shouldIncludePost(post):true;check();
        if(!include){
          // 已有记录的分类纠正也必须落盘后，才能推进本页检查点。
          if(deps.saveExcludedPost)await deps.saveExcludedPost(post);
          check();skipped++;continue;
        }
        const needs=[...(post.needsLongText||[])];let missing=false;
        for(const need of needs){
          try{
            const html=parseLongTextResponse(await request('longtext',{id:need.id}));const text=deps.toText(html);
            if(!text.trim())throw Object.assign(new Error('长文接口内容为空'),{code:'LONGTEXT_EMPTY'});
            if(need.kind==='own') {
              post.text=text;
              if(typeof deps.toEmoticons==='function')post.emoticons=deps.toEmoticons(html);
            }else post.repostText=text;
          }catch(error){
            post.fullText=false;missing=true;post.longTextFailure={kind:need.kind,id:need.id,code:error.code||'LONGTEXT_ERROR',message:String(error.message).slice(0,500)};
            // Retain incomplete content, but leave checkpoint at this page so
            // resume retries the missing long text rather than skipping it.
            await deps.savePost(post);throw error;
          }
        }
        if(needs.length&&!missing)post.fullText=!post.unavailableRepost;delete post.needsLongText;delete post.longTextFailure;
        // Preserve visible own posts even if the endpoint ignores range.
        // Record that discrepancy rather than silently discarding evidence.
        month.incompleteIds ||= [];if(!post.fullText&&!month.incompleteIds.includes(post.id))month.incompleteIds.push(post.id);else if(post.fullText)month.incompleteIds=month.incompleteIds.filter(id=>id!==post.id);
        check();await deps.savePost(post);saved++;check();
      }
      if(outside===posts.length)throw Object.assign(new Error('本页全部记录均在所选月份之外，接口可能忽略时间范围；已暂停'),{code:'RANGE_IGNORED'});
      month.pages.push({page:month.page,at:stamp(),count:list.length,saved,skipped,unknownDates:unknown,outOfRange:outside,reportedTotal:total,signature});
      month.signatures.push(signature);month.page++;await persist();
    }
    check();task.status='range-traversed-unverified';task.stopReason='已遍历所选年月，每月在同一页观察到两次明确空列表；这不是账号全部历史的证明。请核查未知日期、越界记录、目录与人工抽样。';
  }catch(error){
    task.status='paused';task.stopReason=String(error.message||error).slice(0,1000);
    const m=task.months[task.activeMonth];if(m){m.status='paused';m.failure={page:m.page,code:error.code||'ERROR',reason:task.stopReason,at:stamp()};m.emptyEvidence=m.emptyEvidence.filter(e=>e.page!==m.page)}
  }
  await persist();return task;
}
