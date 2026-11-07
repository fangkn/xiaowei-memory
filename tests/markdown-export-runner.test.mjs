import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildArchiveEntries, buildZip, crc32} from '../extension/archive.js';
import {selectMonthlyBatches, verifyMonthlyArchive} from '../extension/monthly.js';
import {createExportJob, matchesExportJob, generatedExportMonths, completedExportMonths, runExportJob} from '../extension/export-runner.js';

const uid = '1000000001', imageURL = 'https://wx1.sinaimg.cn/large/synthetic.png';
const image = Uint8Array.of(137,80,78,71,13,10,26,10);
const records = ['2026-03','2026-04','unknown'].map((month,index) => ({uid,id:`Synthetic${index}`, author:'合成作者',
  createdAt:month === 'unknown' ? null : `${month}-02T02:00:00.000Z`, text:`合成正文 ${month}`, fullText:true,
  images:[imageURL], isRepost:false, contentHash:`current-${index}`, versions:index ? [] : [
    {text:'合成历史观察', createdAt:'2026-03-02T02:00:00.000Z', images:[imageURL], contentHash:'old', fullText:true, isRepost:false},
  ]}));

async function harness({posts=records,images=true}={}) {
  const options={format:'markdown',images,originalOnly:true};
  const batches=await selectMonthlyBatches(posts,{uid,...options});
  const job=createExportJob(uid,options,batches), blobs=new Map();
  const calls={prepared:[],downloads:[],snapshots:[],maxWrite:0,aborts:0};
  let downloadState='complete',failMonth='',latestBlob;
  const downloadStates=new Map();
  const files={
    async put(name,bytes){blobs.set(name,new Blob([bytes]));return {size:bytes.length};},
    async get(name){return blobs.get(name)||null;},
    async remove(name){blobs.delete(name);},
    async createWritable(name){
      const chunks=[];
      return {
        async write(bytes){calls.maxWrite=Math.max(calls.maxWrite,bytes.length);chunks.push(bytes.slice());},
        async close(){blobs.set(name,new Blob(chunks));},
        async abort(){calls.aborts++;},
      };
    },
  };
  const deps={
    openFiles:async()=>files,
    async prepareMonth(batch){
      calls.prepared.push(batch.month);
      if(batch.month===failMonth)throw new Error('合成本月生成失败');
      const entries=buildArchiveEntries({posts:batch.posts,layout:'month-directory',
        media:new Map([[imageURL,{mime:'image/png',bytes:image}]]),report:{mode:images?'text-and-images':'text-only'}});
      const integrity=verifyMonthlyArchive(entries,batch.month,batch.posts.length,{layout:'month-directory'});
      return {bytes:buildZip(entries),extension:'zip',mime:'application/zip',...integrity};
    },
    createObjectURL(blob){latestBlob=blob;return 'blob:synthetic';},revokeObjectURL(){},
    async downloadFile(item){calls.downloads.push({...item,blob:latestBlob});const id=calls.downloads.length;downloadStates.set(id,downloadState);return id;},
    downloadState:async id=>downloadStates.get(id)||'unknown',
    saveJob:async value=>{calls.snapshots.push(structuredClone(value));},
    sleep:async()=>{},
  };
  return {job,batches,options,calls,blobs,files,deps,run:()=>runExportJob({job,batches,options},deps),
    setDownloadState:value=>{downloadState=value;},setFailure:value=>{failMonth=value;}};
}

async function inspectZip(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer),decoder=new TextDecoder(),entries=new Map();
  const end=bytes.length-22;
  assert.equal(view.getUint32(end,true),0x06054b50);
  let offset=view.getUint32(end+16,true);
  for(let i=0;i<view.getUint16(end+10,true);i++){
    assert.equal(view.getUint32(offset,true),0x02014b50);
    const length=view.getUint16(offset+28,true),size=view.getUint32(offset+24,true),local=view.getUint32(offset+42,true);
    const name=decoder.decode(bytes.subarray(offset+46,offset+46+length));
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    const data=bytes.subarray(start,start+size);
    assert.equal(crc32(data),view.getUint32(offset+16,true));
    assert.equal(entries.has(name),false);
    entries.set(name,data);
    offset+=46+length+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
  }
  assert.equal(offset,end);
  return entries;
}

test('Markdown final ZIP has month folders with working image/history links and accurate manifests',async()=>{
  const h=await harness();await h.run();
  assert.equal(h.calls.downloads.length,1);
  assert.equal(h.calls.downloads[0].blob.type,'application/zip');
  assert.equal(h.calls.downloads[0].saveAs,true);
  const entries=await inspectZip(h.calls.downloads[0].blob),decoder=new TextDecoder();
  assert.ok([...entries.keys()].every(name=>!name.endsWith('.zip')));
  assert.deepEqual([...new Set([...entries.keys()].filter(name=>name!=='manifest.json').map(name=>name.split('/')[0]))].sort(),['2026-03','2026-04','未知日期']);
  for(const directory of ['2026-03','2026-04','未知日期']){
    assert.ok(entries.has(`${directory}/${directory}.md`));
    const manifest=JSON.parse(decoder.decode(entries.get(`${directory}/manifest.json`)));
    assert.equal(manifest.exportedPostCount,1);
    for(const record of manifest.records)assert.ok(entries.has(record.path),record.path);
    for(const record of manifest.months){assert.ok(entries.has(record.path));if(record.historyPath)assert.ok(entries.has(record.historyPath));}
  }
  assert.ok(entries.has('2026-03/2026-03-history.md'));
  let images=0;
  for(const [name,bytes]of entries)if(name.endsWith('.md')){
    for(const match of decoder.decode(bytes).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1]));
      assert.deepEqual(entries.get(target),image,`${name} -> ${target}`);images++;
    }
  }
  assert.equal(images,4);
  const manifest=JSON.parse(decoder.decode(entries.get('manifest.json')));
  assert.equal(manifest.archiveLayout,'month-directory-v2');
  assert.deepEqual(manifest.months.map(month=>month.directory),['2026-03','2026-04','未知日期']);
  assert.equal(completedExportMonths(h.job).size,3);
  assert.ok(h.calls.maxWrite<=1024*1024);
});

test('single-month text-only Markdown uses the same folder layout and no media files',async()=>{
  const h=await harness({posts:records.slice(0,1),images:false});await h.run();
  const entries=await inspectZip(h.calls.downloads[0].blob);
  assert.ok(entries.has('2026-03/2026-03.md'));
  assert.ok(entries.has('manifest.json'));
  assert.ok([...entries.keys()].every(name=>!name.endsWith('.zip')&&!name.includes('/assets/')));
  assert.match(new TextDecoder().decode(entries.get('2026-03/2026-03.md')),/纯文字导出/);
  assert.equal(completedExportMonths(h.job).size,1);
});

test('cancelled Markdown downloads reuse all month caches and keep the flattened layout',async()=>{
  const h=await harness();h.setDownloadState('interrupted');
  await assert.rejects(h.run(),error=>error.code==='EXPORT_DOWNLOAD_INTERRUPTED');
  assert.equal(completedExportMonths(h.job).size,0);
  assert.equal(generatedExportMonths(h.job).size,3);
  h.setDownloadState('complete');await h.run();
  assert.equal(h.calls.prepared.length,3);
  assert.equal(h.calls.downloads.length,2);
  assert.ok([...(await inspectZip(h.calls.downloads[1].blob)).keys()].every(name=>!name.endsWith('.zip')));
});

test('failed or missing Markdown month caches regenerate only the affected month before one download',async()=>{
  const h=await harness();h.setFailure('2026-04');await h.run();
  assert.equal(h.calls.downloads.length,0);assert.equal(generatedExportMonths(h.job).size,2);
  h.setFailure('');h.blobs.delete('2026-03.zip');await h.run();
  assert.deepEqual(h.calls.prepared.slice(3),['2026-03','2026-04']);
  assert.equal(h.calls.downloads.length,1);assert.equal(completedExportMonths(h.job).size,3);
});

test('same-size damaged month data aborts packing and its checkpoint is invalidated for retry',async()=>{
  const h=await harness();h.setDownloadState('interrupted');
  await assert.rejects(h.run(),error=>error.code==='EXPORT_DOWNLOAD_INTERRUPTED');
  const bytes=new Uint8Array(await h.blobs.get('2026-03.zip').arrayBuffer()),view=new DataView(bytes.buffer);
  const payload=30+view.getUint16(26,true)+view.getUint16(28,true);bytes[payload]^=1;
  h.blobs.set('2026-03.zip',new Blob([bytes]));h.setDownloadState('complete');
  await assert.rejects(h.run(),error=>error.code==='ZIP_SOURCE_CRC_MISMATCH');
  assert.equal(h.calls.downloads.length,1);assert.equal(h.blobs.has('archive.zip'),false);
  assert.equal(generatedExportMonths(h.job).has('2026-03'),false);
  assert.equal(generatedExportMonths(h.job).size,2);
  await h.run();assert.deepEqual(h.calls.prepared.slice(3),['2026-03']);
  assert.equal(completedExportMonths(h.job).size,3);
});

test('malformed month ZIP caches cannot be downloaded or retained as ready months',async()=>{
  const h=await harness();h.setDownloadState('interrupted');
  await assert.rejects(h.run(),error=>error.code==='EXPORT_DOWNLOAD_INTERRUPTED');
  const bad=buildZip([{name:'another-month/escaped.md',data:'合成内容'}]);
  h.blobs.set('2026-04.zip',new Blob([bad]));h.job.files.find(file=>file.month==='2026-04').size=bad.length;
  h.setDownloadState('complete');await assert.rejects(h.run(),/目录不完整|格式已过期/);
  assert.equal(generatedExportMonths(h.job).has('2026-04'),false);
  assert.equal(h.calls.downloads.length,1);
  await h.run();assert.deepEqual(h.calls.prepared.slice(3),['2026-04']);
});

test('unreadable payload streams invalidate only their month and can recover on the next export',async()=>{
  const h=await harness();h.setDownloadState('interrupted');
  await assert.rejects(h.run(),error=>error.code==='EXPORT_DOWNLOAD_INTERRUPTED');
  const blob=h.blobs.get('2026-03.zip'),bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);
  const start=30+view.getUint16(26,true)+view.getUint16(28,true),end=start+view.getUint32(22,true);
  const get=h.files.get;
  h.files.get=async name=>name==='2026-03.zip'?{size:blob.size,slice(from,to){
    const part=blob.slice(from,to);
    if(from!==start||to!==end)return part;
    return {size:part.size,stream:()=>new ReadableStream({start(controller){controller.error(new DOMException('合成源文件不可读','NotReadableError'));}})};
  }}:get(name);
  h.setDownloadState('complete');
  await assert.rejects(h.run(),error=>error.code==='ZIP_SOURCE_CHANGED'&&error.entryName.startsWith('2026-03/'));
  assert.equal(generatedExportMonths(h.job).has('2026-03'),false);
  assert.equal(generatedExportMonths(h.job).size,2);
  assert.equal(h.calls.downloads.length,1);
  assert.equal(h.blobs.has('archive.zip'),false);
  h.files.get=get;await h.run();
  assert.deepEqual(h.calls.prepared.slice(3),['2026-03']);
  assert.equal(completedExportMonths(h.job).size,3);
});

test('old nested Markdown job receipts are not restored as a new folder export',async()=>{
  const h=await harness();await h.run();
  const previous=structuredClone(h.job);delete previous.markdownLayout;
  assert.equal(matchesExportJob(previous,uid,h.options,h.batches),false);
  assert.equal(generatedExportMonths(previous).size,0);
  assert.equal(completedExportMonths(previous).size,0);
  assert.equal(matchesExportJob(h.job,uid,h.options,h.batches),true);
});
