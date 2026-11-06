import test from 'node:test';import assert from 'node:assert/strict';import {mergePost} from '../extension/model.js';
import {beijingMonth,groupSavedMonths,selectMonthlyBatches,monthlyRevision,monthLedgerKey} from '../extension/monthly.js';
const uid='1000000001';const post=(id,date='2026-11-01T00:00:00Z',extra={})=>({id,uid,key:`${uid}:${id}`,createdAt:date,text:'body',images:[],fullText:true,contentHash:id,versions:[],...extra});
test('Beijing month boundary does not use machine timezone',()=>{assert.equal(beijingMonth(post('A','2026-10-31T15:59:59Z')),'2026-10');assert.equal(beijingMonth(post('B','2026-10-31T16:00:00Z')),'2026-11');assert.equal(beijingMonth(post('C',null)),'unknown')});
test('101 same-month posts stay one whole month in chronological order',async()=>{const posts=Array.from({length:101},(_,i)=>post(`R${String(i).padStart(4,'0')}`,new Date(Date.parse('2026-11-01T00:00:00Z')+i*60000).toISOString())).reverse();const batches=await selectMonthlyBatches(posts,{uid});assert.equal(batches.length,1);assert.equal(batches[0].posts.length,101);assert.equal(batches[0].posts[0].id,'R0000');assert.equal(batches[0].posts.at(-1).id,'R0100')});
test('one edited item triggers entire local month, not just changed post',async()=>{const a=await mergePost(null,post('Ra')),b=await mergePost(null,post('Rb'));const before=(await selectMonthlyBatches([a,b],{uid}))[0],ledger={[before.month]:before.revision};assert.equal((await selectMonthlyBatches([a,b],{uid,incremental:true,ledger})).length,0);const edited=await mergePost(a,{...a,text:'edited'});const next=await selectMonthlyBatches([edited,b],{uid,incremental:true,ledger});assert.equal(next.length,1);assert.deepEqual(next[0].posts.map(p=>p.id),['Ra','Rb']);assert.notEqual(next[0].revision,before.revision)});
test('new month member changes revision and retains stored source-deleted posts',async()=>{const storedDeleted=post('Rold'),before=(await selectMonthlyBatches([storedDeleted],{uid}))[0];const next=await selectMonthlyBatches([storedDeleted,post('Rnew')],{uid,incremental:true,ledger:{[before.month]:before.revision}});assert.equal(next[0].posts.length,2);assert.ok(next[0].posts.includes(storedDeleted))});
test('unknown date is its own full batch and not silently removed by month filter',async()=>{const result=await selectMonthlyBatches([post('Runknown',null),post('Rold','2026-01-01T00:00:00Z'),post('Rnew')],{uid,fromMonth:'2026-11',toMonth:'2026-11'});assert.deepEqual(result.map(x=>x.month),['2026-11','unknown']);assert.equal(result[1].posts[0].id,'Runknown')});
test('history versions and media mode change monthly revision; old item ledger cannot skip month',async()=>{const p=post('Ra'),batch=groupSavedMonths([p],uid)[0],rev=await monthlyRevision(batch);assert.notEqual(await monthlyRevision(batch,true),rev);assert.notEqual(await monthlyRevision({...batch,posts:[{...p,versions:[{...p,contentHash:'prior'}]}]}),rev);assert.equal((await selectMonthlyBatches([p],{uid,incremental:true,ledger:{[p.key]:p.contentHash}})).length,1);assert.equal(monthLedgerKey(uid),`exported-months:v3:${uid}`)});
test('empty selection and invalid range are explicit, other accounts excluded',async()=>{assert.deepEqual(await selectMonthlyBatches([],{uid}),[]);assert.deepEqual(await selectMonthlyBatches([{...post('Rother'),uid:'999999'}],{uid}),[]);await assert.rejects(selectMonthlyBatches([],{uid,fromMonth:'2026-11-01'}),/月份范围/);await assert.rejects(selectMonthlyBatches([],{uid,fromMonth:'2026-12',toMonth:'2026-11'}),/月份范围/)});

test('within-month order compares instants even when valid offsets differ',()=>{const groups=groupSavedMonths([post('Rlater','2026-11-01T01:00:00Z'),post('Rearlier','2026-11-01T08:30:00+08:00')],uid);assert.deepEqual(groups[0].posts.map(p=>p.id),['Rearlier','Rlater'])});

test('malformed dates classify identically to archive as unknown',async()=>{const {buildArchiveEntries}=await import('../extension/archive.js');for(const date of ['2026-02-30T00:00:00Z','2026-11-01T00:00:00']){const p=post('Rbad',date),batch=(await selectMonthlyBatches([p],{uid}))[0];assert.equal(batch.month,'unknown');const entries=buildArchiveEntries({posts:batch.posts});assert.ok(entries.some(e=>e.name===`微博备份/${uid}/未知日期.md`))}});
test('archive verification detects omitted posts and empty-body image failures',async()=>{const {buildArchiveEntries}=await import('../extension/archive.js');const {verifyMonthlyArchive}=await import('../extension/monthly.js');const url='https://wx1.sinaimg.cn/large/empty.jpg';const p=post('Rimg',undefined,{images:[url]});const entries=buildArchiveEntries({posts:[p],media:new Map([[url,{bytes:new Uint8Array(),mime:'image/jpeg'}]])});assert.equal(verifyMonthlyArchive(entries,'2026-11',1).failedImageCount,1);assert.throws(()=>verifyMonthlyArchive(entries,'2026-11',2),/条数/);assert.throws(()=>verifyMonthlyArchive(entries,'2026-10',1),/月份/);assert.throws(()=>verifyMonthlyArchive([],'2026-11',0),/清单/)});

test('original-only month excludes reposts, historical quotes, and all-repost months without mutating storage',async()=>{
  const original=post('Rown'),repost=post('Rquote',undefined,{isRepost:true,repostText:'转发原文'});
  const lostQuote=post('Rlost',undefined,{isRepost:false,versions:[{isRepost:true,repostText:'以前读到的引用'}]});
  const otherMonth=post('Rold','2026-10-01T00:00:00Z',{isRepost:true});
  const input=[original,repost,lostQuote,otherMonth],before=structuredClone(input);
  const batches=await selectMonthlyBatches(input,{uid,originalOnly:true,format:'pdf'});
  assert.deepEqual(batches.map(b=>b.month),['2026-11']);assert.deepEqual(batches[0].posts.map(p=>p.id),['Rown']);
  assert.deepEqual(input,before);assert.equal((await selectMonthlyBatches(input,{uid})).length,2);
});

test('PDF and original-only exports have independent receipts and revisions',async()=>{
  const original=post('Rown'),base=(await selectMonthlyBatches([original],{uid}))[0];
  const originalMD=(await selectMonthlyBatches([original],{uid,originalOnly:true}))[0];
  const pdf=(await selectMonthlyBatches([original],{uid,format:'pdf',originalOnly:true}))[0];
  assert.notEqual(base.revision,originalMD.revision);assert.notEqual(originalMD.revision,pdf.revision);
  assert.equal(new Set([monthLedgerKey(uid),monthLedgerKey(uid,{originalOnly:true}),monthLedgerKey(uid,{format:'pdf',originalOnly:true})]).size,3);
  assert.equal((await selectMonthlyBatches([original],{uid,format:'pdf',originalOnly:true,incremental:true,ledger:{[base.month]:base.revision}})).length,1);
  assert.equal((await selectMonthlyBatches([original],{uid,format:'pdf',originalOnly:true,incremental:true,ledger:{[pdf.month]:pdf.revision}})).length,0);
});

test('corrected legacy original does not export its obsolete repost-marked observation',async()=>{
  const legacy=await mergePost(null,post('Rlegacy',undefined,{isRepost:true,repostText:'',repostUrl:''}));
  const fixed=await mergePost(legacy,{...legacy,isRepost:false,repostDetectionVersion:2});
  const batch=(await selectMonthlyBatches([fixed],{uid,originalOnly:true}))[0];
  assert.equal(batch.posts.length,1);assert.equal(batch.posts[0].versions.length,0);
  assert.equal(fixed.versions.length,1,'stored observations remain untouched');
});
