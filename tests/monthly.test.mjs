import test from 'node:test';import assert from 'node:assert/strict';import {mergePost} from '../extension/model.js';
import {beijingMonth,groupSavedMonths,selectMonthlyBatches,monthlyRevision,monthLedgerKey} from '../extension/monthly.js';
import {createExportJob,matchesExportJob} from '../extension/export-runner.js';
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

test('combined PDF keeps complete selected months and uses receipts independent from monthly PDF',async()=>{
  const posts=[post('Old','2026-10-01T00:00:00Z'),post('New')];
  const combined=await selectMonthlyBatches(posts,{uid,format:'pdf-combined',originalOnly:true});
  const pdf=await selectMonthlyBatches(posts,{uid,format:'pdf',originalOnly:true});
  assert.notEqual(combined[0].revision,pdf[0].revision);
  assert.notEqual(monthLedgerKey(uid,{format:'pdf-combined',originalOnly:true}),monthLedgerKey(uid,{format:'pdf',originalOnly:true}));
  const ledger=Object.fromEntries(combined.map(batch=>[batch.month,batch.revision]));
  assert.deepEqual(await selectMonthlyBatches(posts,{uid,format:'pdf-combined',originalOnly:true,incremental:true,ledger}),combined);
  const selected=await selectMonthlyBatches(posts,{uid,format:'pdf-combined',originalOnly:true,fromMonth:'2026-11',toMonth:'2026-11',incremental:true,ledger});
  assert.deepEqual(selected.map(batch=>batch.month),['2026-11']);
});

test('new PDF presentation invalidates old confirmed revisions and generated job snapshots without changing ledger keys',async()=>{
  // 固定为排版升级前真实生成的修订值，防止测试与实现一起改变而掩盖兼容回退。
  const oldRevisions={
    pdf:['5f82ae38d7040a99a8f1f9f8b40b1de3eb23232c8e835de3cb42a083f4089093','b1a65ac4b81a17b5883fee63f0ee09efd730a53f451ff172185bd9824ceb149e'],
    'pdf-combined':['905d6b965d0fd7e6e6abef64af4640798f815d79a0cbc5c0dd4e0f35f6f70652','22680284aa9dd4314d8ec5da9224a3908afac68a23b1adb911a183c359d687df'],
  };
  const posts=[post('Layout1')],before=structuredClone(posts);
  for(const format of ['pdf','pdf-combined'])for(const images of [false,true]){
    const options={uid,format,images,originalOnly:true},oldRevision=oldRevisions[format][Number(images)];
    const oldBatches=groupSavedMonths(posts,uid,{originalOnly:true}).map(batch=>({...batch,revision:oldRevision}));
    const previous=createExportJob(uid,options,oldBatches);
    const selected=await selectMonthlyBatches(posts,{...options,incremental:true,ledger:{'2026-11':oldRevision}});
    assert.equal(selected.length,1,`${format} ${images}: old confirmation cannot hide the redesigned PDF`);
    assert.notEqual(selected[0].revision,oldRevision);
    assert.equal(matchesExportJob(previous,uid,options,selected),false,'old generated PDF must be rebuilt');
    assert.equal(monthLedgerKey(uid,options),`exported-months:v3:${format}:original:${uid}`);
    assert.equal(matchesExportJob(createExportJob(uid,options,selected),uid,options,selected),true);
  }
  assert.deepEqual(posts,before,'presentation upgrade must not modify saved source records');
});

test('month-directory Markdown invalidates old confirmed revisions and checkpoints without changing ledger keys',async()=>{
  const revisions=[
    ['598aed4cc1a77613b7286de5dcefa025537f7e71c66d326b48fbe7606ec2406e','fd2472f4ba0cabd8d70e780edfd94bdae7e0a43f38aaf54bd7dfe0a98125b9be'],
    ['16a7b9705fe212bb31bca757604a502c0cce12bfa985bcb95cb97d122a222f88','5e51cc48b2ea3e3a8fcff2d52a06757001a1c4f0dd273b202c3096395a2c0875'],
  ];
  for(const originalOnly of [false,true])for(const images of [false,true]){
    const options={uid,format:'markdown',originalOnly,images},posts=[post('Layout1')];
    const revision=revisions[Number(originalOnly)][Number(images)];
    const previousBatches=groupSavedMonths(posts,uid,{originalOnly}).map(batch=>({...batch,revision}));
    const current=await selectMonthlyBatches(posts,options);
    assert.notEqual(current[0].revision,revision,'old nested ZIP layout must be rebuilt');
    assert.deepEqual(await selectMonthlyBatches(posts,{...options,incremental:true,ledger:{'2026-11':revision}}),current);
    assert.equal(monthLedgerKey(uid,options),originalOnly?`exported-months:v3:markdown:original:${uid}`:`exported-months:v3:${uid}`);
    assert.equal(matchesExportJob(createExportJob(uid,options,previousBatches),uid,options,current),false);
    assert.equal(matchesExportJob(createExportJob(uid,options,current),uid,options,current),true);
    assert.deepEqual(await selectMonthlyBatches(posts,{...options,incremental:true,ledger:{'2026-11':current[0].revision}}),[]);
  }
});

test('Markdown layout upgrade preserves current PDF revisions and reusable checkpoints',async()=>{
  // 固定修改前的 PDF 指纹，覆盖两种格式、图片设置与原创过滤设置。
  const revisions={
    pdf:[
      ['28b7bd5957bdcfa9ff60b4f5d03563dcfa4499153eb67ec79211abc1a09504fa','b89a56af2476df4d67458695278d1617d11e4ce631d3957ac7d0dbb6683588da'],
      ['6610b1a5cad8c929af280ad3cb69fd7fedbd79c793084a88d2a852878f1f394e','e3f72950365932107f44adb40f53a335193f2f7b658381b1dfe749115538e1ee'],
    ],
    'pdf-combined':[
      ['f7e0ab3a7f00c31057e0a951c4cabbdaeae4667f70b8a7ef3fe25379c99ccee8','ac696bf432e2b79c900dc3c5b5fb0e069bcb46be311c609249c6ef072668f888'],
      ['349dde45cb8226d73aa003c2b9943e3429c522571b708e1736b2a3e56afc7c7f','4518afa6ce27de5c6f4495f4c1294eecee6ebe41f19e122ba0498c46b681bb65'],
    ],
  };
  for(const format of ['pdf','pdf-combined'])for(const originalOnly of [false,true])for(const images of [false,true]){
    const options={uid,format,originalOnly,images},posts=[post('Layout1')],before=structuredClone(posts);
    const revision=revisions[format][Number(originalOnly)][Number(images)],current=await selectMonthlyBatches(posts,options);
    assert.equal(current[0].revision,revision);
    const previous=groupSavedMonths(posts,uid,{originalOnly}).map(batch=>({...batch,revision}));
    assert.equal(matchesExportJob(createExportJob(uid,options,previous),uid,options,current),true);
    assert.equal(monthLedgerKey(uid,options),`exported-months:v3:${format}:${originalOnly?'original':'all'}:${uid}`);
    assert.deepEqual(posts,before);
  }
});

test('month-directory verification checks the actual month folder and all current and history note paths',async()=>{
  const {buildArchiveEntries}=await import('../extension/archive.js'),{verifyMonthlyArchive}=await import('../extension/monthly.js');
  for(const month of ['2026-11','unknown']){
    const p=post('Layout1',month==='unknown'?null:undefined,{versions:[post('Layout1','2025-01-01T00:00:00Z',{contentHash:'old'})]});
    const entries=buildArchiveEntries({posts:[p],layout:'month-directory'}),folder=month==='unknown'?'未知日期':month;
    assert.deepEqual(verifyMonthlyArchive(entries,month,1,{layout:'month-directory'}),{failedImageCount:0,savedImageCount:0});
    assert.throws(()=>verifyMonthlyArchive(entries,month,1),/清单/);
    assert.throws(()=>verifyMonthlyArchive(entries,month,2,{layout:'month-directory'}),/条数/);
    assert.throws(()=>verifyMonthlyArchive(entries.filter(entry=>!entry.name.endsWith('-history.md')),month,1,{layout:'month-directory'}),/笔记链接/);
    for(const change of [
      manifest=>{manifest.archiveLayout='monthly-v1';},manifest=>{manifest.months[0].path='../escape.md';},
      manifest=>{manifest.records[0].path='missing.md';},manifest=>{manifest.records[0].uid='other';},
      manifest=>{manifest.records[0].month='2025-01';},manifest=>{manifest.months[0].historyPath='missing.md';},
    ]){
      const bad=structuredClone(entries),item=bad.find(entry=>entry.name===`${folder}/manifest.json`),manifest=JSON.parse(item.data);
      change(manifest);item.data=JSON.stringify(manifest);assert.throws(()=>verifyMonthlyArchive(bad,month,1,{layout:'month-directory'}),/笔记链接/);
    }
    for(const name of ['outside.md',`${folder}/../escape.md`,`${folder}/a\\b.md`])
      assert.throws(()=>verifyMonthlyArchive([...entries,{name,data:''}],month,1,{layout:'month-directory'}),/月份目录/);
    assert.throws(()=>verifyMonthlyArchive([...entries,entries[0]],month,1,{layout:'month-directory'}),/月份目录/);
  }
  assert.throws(()=>verifyMonthlyArchive([],'../../escape',1,{layout:'month-directory'}),/月份无效/);
  assert.throws(()=>verifyMonthlyArchive([],'2026-11',1,{layout:'other'}),/布局/);
});
