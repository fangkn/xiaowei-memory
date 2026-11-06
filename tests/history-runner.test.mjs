import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryTask,runHistoryTask,historyCoverage,historyTaskKey} from '../extension/history-runner.js';
import {isOriginalPost} from '../extension/model.js';
const UID='1234567890',NOW=Date.parse('2026-11-01T04:00:00Z');
const task=(from='2026-01',to=from)=>createHistoryTask(UID,from,to,NOW);
const post=(id='Rabcde',date='2026-01-15T00:00:00Z',extra={})=>({id,uid:UID,author:'测试账号',url:`https://weibo.com/${UID}/${id}`,createdAt:date,dateRaw:date,text:'正文',repostText:'',images:[],fullText:true,needsLongText:[],...extra});
const page=(list=[],total=list.length)=>({ok:1,data:{list,total}});
const fail=(code,message=code)=>Object.assign(new Error(message),{code});
function harness(handler,overrides={}){
  const calls=[],saved=[],snapshots=[];let paused=false;
  const deps={
    request:async(kind,params)=>{calls.push({kind,...params});return handler(kind,params,calls.length)},
    normalize:raw=>structuredClone(raw),
    toText:html=>String(html).replace(/<[^>]*>/g,''),
    savePost:async p=>{saved.push(structuredClone(p))},
    saveTask:async t=>{snapshots.push(structuredClone(t))},
    wait:async()=>{},shouldPause:()=>paused,
    ...overrides,
  };
  return {deps,calls,saved,snapshots,pause:()=>{paused=true}};
}

test('history task plans all months and coverage never promises whole history',()=>{
  const t=task('2026-01','2026-02');assert.deepEqual(t.months.map(m=>m.key),['2026-01','2026-02']);
  assert.equal(historyTaskKey(t),`history:${UID}:2026-01:2026-02`);
  const coverage=historyCoverage(t);assert.equal(coverage.allHistoryGuaranteed,false);assert.equal(coverage.months[0].nextPage,1);
});

test('normal multi-month traversal commits posts then requires two same-page empty responses',async()=>{
  const t=task('2026-01','2026-02');
  const h=harness((_kind,p)=>p.page===1?page([post(p.starttime===t.months[0].starttime?'Rjan01':'Rfeb01',new Date((p.starttime+3600)*1000).toISOString())]):page());
  const result=await runHistoryTask(t,h.deps);
  assert.equal(result.status,'range-traversed-unverified');assert.equal(result.activeMonth,2);assert.equal(result.allHistoryGuaranteed,false);
  assert.equal(h.saved.length,2);assert.deepEqual(h.calls.map(c=>c.page),[1,2,2,1,2,2]);
  assert.equal(result.months[0].pages.length,1);assert.equal(result.months[1].emptyEvidence.length,2);
  assert.equal(t.status,'ready','input object is not mutated');
});

test('one empty response followed by data retries same page and discards stale empty evidence',async()=>{
  let n=0;const h=harness(()=>++n===1?page():n===2?page([post()]):page());
  const result=await runHistoryTask(task(),h.deps);
  assert.deepEqual(h.calls.map(c=>c.page),[1,1,2,2]);assert.equal(result.months[0].pages[0].page,1);
  assert.deepEqual(result.months[0].emptyEvidence.map(e=>e.page),[2,2]);assert.equal(h.saved.length,1);
});

for(const [name,response] of [
  ['missing list',{ok:1,data:{total:0}}],
  ['error JSON',{ok:0,msg:'接口错误'}],
  ['rate limit JSON',{ok:0,msg:'访问过于频繁'}],
  ['non-object JSON',null],
])test(`${name} pauses without skipping or treating response as empty`,async()=>{
  const h=harness(()=>response);const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.activeMonth,0);assert.equal(result.months[0].page,1);
  assert.equal(result.months[0].pages.length,0);assert.equal(result.months[0].emptyEvidence.length,0);
  assert.equal(h.calls.length,1);assert.equal(h.saved.length,0);
});

for(const code of ['HTTP','RATE_LIMIT','TIMEOUT','INVALID_JSON'])test(`${code} transport failure retains page checkpoint and retries it on resume`,async()=>{
  const first=harness(()=>{throw fail(code)});const paused=await runHistoryTask(task(),first.deps);
  assert.equal(paused.months[0].failure.code,code);assert.equal(paused.months[0].page,1);
  const second=harness((_kind,p)=>p.page===1?page([post()]):page());const resumed=await runHistoryTask(paused,second.deps);
  assert.equal(second.calls[0].page,1);assert.equal(resumed.status,'range-traversed-unverified');assert.equal(second.saved.length,1);
});

test('partial page write failure never advances checkpoint and safe replay persists all records',async()=>{
  const input=page([post('Rone01'),post('Rtwo02')]);let writes=0;
  const first=harness(()=>input,{savePost:async()=>{if(++writes===2)throw fail('QUOTA','存储配额不足')}});
  const paused=await runHistoryTask(task(),first.deps);
  assert.equal(paused.months[0].page,1);assert.equal(paused.months[0].pages.length,0);assert.equal(writes,2);
  const second=harness((_kind,p)=>p.page===1?input:page());const resumed=await runHistoryTask(paused,second.deps);
  assert.equal(resumed.status,'range-traversed-unverified');assert.deepEqual(second.saved.map(p=>p.id),['Rone01','Rtwo02']);
});

test('pause after network await prevents parsing, saving and page advance',async()=>{
  let h;h=harness(()=>{h.pause();return page([post()])});const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.months[0].failure.code,'USER_PAUSED');assert.equal(result.months[0].page,1);assert.equal(h.saved.length,0);
});

test('pause during post persistence preserves record but leaves checkpoint at same page',async()=>{
  let h;h=harness(()=>page([post()]),{savePost:async p=>{h.saved.push(structuredClone(p));h.pause()}});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.months[0].page,1);assert.equal(result.months[0].pages.length,0);assert.equal(h.saved.length,1);
});

test('pause while saving second empty evidence cannot mark month traversed',async()=>{
  let h;h=harness(()=>page(),{saveTask:async t=>{h.snapshots.push(structuredClone(t));if(t.months[0].emptyEvidence.length===2)h.pause()}});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.activeMonth,0);assert.equal(result.months[0].page,1);assert.equal(result.months[0].status,'paused');
});

test('repeated page signature stops a server that ignores page number',async()=>{
  const h=harness(()=>page([post()]));const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.months[0].failure.code,'REPEATED_PAGE');assert.equal(result.months[0].page,2);
  assert.equal(result.months[0].pages.length,1);assert.equal(h.saved.length,1);assert.equal(h.calls.length,2);
});

test('long text failure saves partial, keeps page, and resume fills own and quoted text',async()=>{
  const raw=post('Rlong1',undefined,{fullText:false,text:'摘要',repostText:'引用摘要',needsLongText:[{id:'Rlong1',kind:'own'},{id:'Rquote',kind:'repost'}]});
  const first=harness(kind=>{if(kind==='longtext')throw fail('LONGTEXT_UNAVAILABLE');return page([raw])});
  const paused=await runHistoryTask(task(),first.deps);
  assert.equal(paused.status,'paused');assert.equal(paused.months[0].page,1);assert.equal(first.saved[0].fullText,false);assert.equal(first.saved[0].longTextFailure.code,'LONGTEXT_UNAVAILABLE');
  const second=harness((kind,p)=>kind==='longtext'?{ok:1,data:{longTextContent:p.id==='Rlong1'?'<p>自己的完整正文</p>':'<p>转发完整正文</p>'}}:p.page===1?page([raw]):page());
  const resumed=await runHistoryTask(paused,second.deps);
  assert.equal(resumed.status,'range-traversed-unverified');assert.equal(second.saved[0].text,'自己的完整正文');assert.equal(second.saved[0].repostText,'转发完整正文');assert.equal(second.saved[0].fullText,true);assert.equal('needsLongText' in second.saved[0],false);
});

test('invalid long text response pauses instead of marking truncated text complete',async()=>{
  const h=harness(kind=>kind==='longtext'?{ok:1,data:{}}:page([post('Rlong1',undefined,{fullText:false,needsLongText:[{id:'Rlong1',kind:'own'}]})]));
  const result=await runHistoryTask(task(),h.deps);assert.equal(result.status,'paused');assert.equal(result.months[0].page,1);assert.equal(h.saved[0].fullText,false);
});

test('long text supplement retains emoticon sources from the complete own body',async()=>{
  const raw=post('Rlong1',undefined,{fullText:false,text:'摘要',needsLongText:[{id:'Rlong1',kind:'own'}]});
  const emoticons=[{text:'[笑cry]',url:'https://h5.sinaimg.cn/m/emoticon/laugh.png'}];
  let extracted='';
  const h=harness((kind,p)=>kind==='longtext'?{ok:1,data:{longTextContent:'完整内容[笑cry]'}}:p.page===1?page([raw]):page(),
    {toEmoticons:html=>{extracted=html;return emoticons;}});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'range-traversed-unverified');
  assert.equal(extracted,'完整内容[笑cry]');
  assert.deepEqual(h.saved[0].emoticons,emoticons);
});

test('unknown and out-of-range dates remain visible in coverage rather than silently discarded',async()=>{
  const h=harness((_kind,p)=>p.page===1?page([post('Rgood1'),post('Rnone2',null),post('Rold03','2020-01-01T00:00:00Z')]):page());
  const result=await runHistoryTask(task(),h.deps),coverage=historyCoverage(result);
  assert.equal(h.saved.length,3);assert.deepEqual(coverage.months[0].unknownDateIds,['Rnone2']);assert.deepEqual(coverage.months[0].outOfRangeIds,['Rold03']);assert.equal(coverage.allHistoryGuaranteed,false);
});

test('entirely out-of-range page pauses rather than certifying a month',async()=>{
  const h=harness(()=>page([post('Rold03','2020-01-01T00:00:00Z')]));const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.months[0].failure.code,'RANGE_IGNORED');assert.equal(result.months[0].page,1);assert.equal(h.saved.length,1);
});

test('page and global request safety limits stop without a network call',async()=>{
  for(const kind of ['page','request']){
    const t=task();if(kind==='page')t.months[0].page=1001;else t.requests=10000;
    const h=harness(()=>{throw new Error('must not request')});const result=await runHistoryTask(t,h.deps);
    assert.equal(result.status,'paused');assert.equal(h.calls.length,0);assert.equal(result.months[0].failure.code,kind==='page'?'PAGE_LIMIT':'REQUEST_LIMIT');
  }
});

test('pause during pre-request checkpoint prevents the pending network request',async()=>{
  let h;h=harness(()=>page(),{saveTask:async t=>{h.snapshots.push(structuredClone(t));if(t.requests===1&&h.calls.length===0)h.pause()}});
  const result=await runHistoryTask(task(),h.deps);assert.equal(result.status,'paused');assert.equal(h.calls.length,0);assert.equal(result.months[0].page,1);
});

test('own longtext success does not mark deleted quoted content complete',async()=>{const input=post('Rquote0','2026-01-15T00:00:00Z',{fullText:false,unavailableRepost:true,isRepost:true,repostText:'原文已删除',needsLongText:[{id:'Rquote0',kind:'own'}]});const h=harness((kind,p)=>kind==='longtext'?{ok:1,data:{longTextContent:'完整自己的正文'}}:p.page===1?page([input]):page());await runHistoryTask(task(),h.deps);assert.equal(h.saved[0].text,'完整自己的正文');assert.equal(h.saved[0].fullText,false);assert.equal(h.saved[0].unavailableRepost,true)});

test('repost-only page advances without saving or fetching quotes and still finds later originals',async()=>{
  const quote=post('Rquote',undefined,{isRepost:true,fullText:false,needsLongText:[{id:'Rquote',kind:'own'},{id:'Rother',kind:'repost'}]});
  const h=harness((kind,p)=>{assert.equal(kind,'search');return p.page===1?page([quote]):p.page===2?page([post('Rown')]):page()}, {shouldIncludePost:isOriginalPost});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'range-traversed-unverified');assert.deepEqual(h.saved.map(p=>p.id),['Rown']);
  assert.deepEqual(h.calls.map(c=>c.page),[1,2,3,3]);
  assert.equal(result.months[0].pages[0].saved,0);assert.equal(result.months[0].pages[0].skipped,1);
  assert.equal(result.months[0].pages[1].saved,1);assert.equal(result.months[0].pages[1].skipped,0);
});

test('filtering cannot conceal out-of-range or wrong-account repost pages',async()=>{
  const h=harness(()=>page([post('Rquote','2020-01-01T00:00:00Z',{isRepost:true})]),{shouldIncludePost:isOriginalPost});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.months[0].failure.code,'RANGE_IGNORED');assert.equal(result.months[0].page,1);assert.equal(h.saved.length,0);
  const wrong=harness(()=>page([{...post('Rwrong'),uid:'999999',isRepost:true}]),{shouldIncludePost:isOriginalPost});
  assert.equal((await runHistoryTask(task(),wrong.deps)).months[0].failure.code,'POST_SCHEMA');
});

test('pause during asynchronous filter retains the current page',async()=>{
  let h;h=harness(()=>page([post('Rquote',undefined,{isRepost:true})]),{shouldIncludePost:async()=>{h.pause();return false}});
  const result=await runHistoryTask(task(),h.deps);
  assert.equal(result.status,'paused');assert.equal(result.months[0].failure.code,'USER_PAUSED');assert.equal(result.months[0].page,1);assert.equal(result.months[0].pages.length,0);
});
