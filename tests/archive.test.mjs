import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildArchiveEntries,buildZip,renderMarkdown,postAnchor,crc32,MAX_ARCHIVE_BYTES,MONTH_DIRECTORY_LAYOUT} from '../extension/archive.js';
const post={id:'Rpabc123',uid:'123456789',author:'测试"作者\nabc',url:'https://weibo.com/123456789/Rpabc123?token=secret#x',createdAt:'2026-10-31T17:00:00Z',dateRaw:'11月1日 01:00',text:'你好\n<img src="https://evil.com/a"> ![x](https://evil.com/a)',images:['https://wx1.sinaimg.cn/large/a.jpg?token=secret'],fullText:true,firstSeenAt:'2026-11-01T01:00:00Z'};
const mediaFor=p=>new Map(p.images.map(url=>[url,{bytes:new Uint8Array([1,2,3]),mime:'image/jpeg'}]));
const manifest=entries=>JSON.parse(entries.find(e=>e.name==='微博备份/manifest.json').data);
const mainNotes=entries=>entries.filter(e=>/\/(?:\d{4}-\d{2}|未知日期)\.md$/.test(e.name));

test('entry safely escapes content and anchors and rejects remote image paths',()=>{
 const md=renderMarkdown(post,['../assets/Rpabc123/01.jpg']);
 assert.ok(md.includes('作者：测试"作者 abc'));assert.ok(!md.includes('<img'));assert.ok(!md.includes('![x](https'));assert.ok(!md.includes('token=secret'));
 assert.match(md,/!\[图片 1\]\(\.\.\/assets\/Rpabc123\/01.jpg\)/);assert.ok(!renderMarkdown(post,['https://evil.com/a','../../assets/Rpabc123/01.jpg']).includes('![图片'));
 assert.ok(renderMarkdown({...post,text:'spoof ^weibo-abc'}).includes('\\^weibo-abc'));
});
test('one monthly main note uses Beijing month, local media and deduplicates',()=>{
 const entries=buildArchiveEntries({posts:[post,post],media:mediaFor(post),report:{status:'paused',token:'DO-NOT-SAVE'}});
 assert.equal(mainNotes(entries).length,1);assert.equal(mainNotes(entries)[0].name,'微博备份/123456789/2026/2026-11.md');
 const m=manifest(entries);assert.equal(m.exportedPostCount,1);assert.equal(m.mainNoteCount,1);assert.equal(m.savedImageCount,1);assert.equal(m.allHistoryGuaranteed,false);assert.equal(m.records[0].path,mainNotes(entries)[0].name);assert.equal(m.records[0].anchor,postAnchor(post));assert.ok(!JSON.stringify(entries).includes('DO-NOT-SAVE'));
});
test('legacy image addresses retain original cache keys in current and historical Markdown entries',()=>{
 const images=['http://wx1.sinaimg.cn/large/old.jpg?token=secret','//wx2.sinaimg.cn/large/relative.jpg','http://img.t.sinajs.cn/t4/old.gif','https://face.t.sinajs.cn/t4/face.gif'];
 const current={...post,images,versions:[{...post,images:[images[0]],contentHash:'old-snapshot'}]};
 const entries=buildArchiveEntries({posts:[current],media:mediaFor(current)}),m=manifest(entries);
 assert.equal(m.failedImageCount,0);assert.equal(m.savedImageCount,5);
 assert.equal(entries.filter(entry=>entry.name.includes('/assets/')).length,5);
 assert.ok(!JSON.stringify(m).includes('token=secret'));
});
test('legacy image compatibility never embeds unrelated hosts or credential URLs from cache',()=>{
 const p={...post,images:['http://evil.test/a.jpg','https://img.t.sinajs.cn.evil.test/a.jpg','http://user:pass@wx1.sinaimg.cn/a.jpg','http://wx1.sinaimg.cn:8080/a.jpg']};
 const m=manifest(buildArchiveEntries({posts:[p],media:mediaFor(p)}));
 assert.equal(m.savedImageCount,0);assert.equal(m.failedImageCount,4);
});
test('same month 101 posts remains one chronological note rather than 100-entry chunks',()=>{
 const posts=Array.from({length:101},(_,i)=>({...post,id:`R${String(i).padStart(5,'0')}`,createdAt:new Date(Date.parse('2026-11-01T00:00:00+08:00')+i*60000).toISOString(),text:`entry-${i}`,images:[]})).reverse();
 const entries=buildArchiveEntries({posts});const [note]=mainNotes(entries);assert.equal(mainNotes(entries).length,1);assert.equal(manifest(entries).exportedPostCount,101);
 assert.equal((note.data.match(/^## /gm)||[]).length,101);assert.ok(note.data.indexOf('entry-0')<note.data.indexOf('entry-100'));
});
test('month boundary uses Asia/Shanghai and unknown date is a separate single note',()=>{
 const entries=buildArchiveEntries({posts:[{...post,id:'Rbefore',createdAt:'2026-10-31T15:59:59Z',images:[]},{...post,id:'Rafter',createdAt:'2026-10-31T16:00:00Z',images:[]},{...post,id:'Runknown',createdAt:null,images:[]},{...post,id:'Rinvalid',createdAt:'2026-02-30T00:00:00Z',images:[]},{...post,id:'Rnotz',createdAt:'2026-11-01T12:00:00',images:[]}]});
 assert.deepEqual(mainNotes(entries).map(n=>n.name).sort(),['微博备份/123456789/2026/2026-10.md','微博备份/123456789/2026/2026-11.md','微博备份/123456789/未知日期.md'].sort());
 const unknown=mainNotes(entries).find(n=>n.name.endsWith('未知日期.md'));assert.equal((unknown.data.match(/^## /gm)||[]).length,3);assert.match(unknown.data,/日期未知/);
});
test('stable valid block anchors are unique and independent of edit/date/order',()=>{
 assert.equal(postAnchor(post),postAnchor({...post,text:'edit',createdAt:null}));assert.match(postAnchor(post),/^[A-Za-z0-9-]+$/);
 assert.notEqual(postAnchor({...post,id:'a_b'}),postAnchor({...post,id:'a-b'}));assert.notEqual(postAnchor({...post,id:'a-b'}),postAnchor({...post,id:'a2db'}));
});
test('missing images and unknown dates are explicit; SVG not exported',()=>{
 const p={...post,createdAt:null,fullText:false};const entries=buildArchiveEntries({posts:[p],media:new Map([[p.images[0],{bytes:new Uint8Array([1]),mime:'image/svg+xml'}]])});
 assert.ok(entries.some(e=>e.name.endsWith('/未知日期.md')));const m=manifest(entries);assert.equal(m.failedImageCount,1);assert.equal(m.completeTextCount,0);assert.ok(!JSON.stringify(m).includes('token=secret'));
});
test('source URLs reject credentials/offsite and cannot inject Markdown images',()=>{
 assert.ok(!renderMarkdown({...post,url:'https://user:password@weibo.com/123/abc'}).includes('password'));
 assert.ok(!renderMarkdown({...post,url:'https://evil.com/123/abc'}).includes('evil.com/123'));
 assert.ok(!renderMarkdown({...post,url:'https://weibo.com/x)![evil](https://evil.com/a)'}).includes('![evil]('));
});
test('unsafe IDs cannot become filenames or block anchors',()=>{
 assert.throws(()=>buildArchiveEntries({posts:[{...post,id:'../escape'}]}),/不合法/);
 assert.throws(()=>renderMarkdown(post,[],{anchor:'bad]anchor'}),/锚点/);
});
test('history versions share one monthly history note, not one note per post',()=>{
 const p={...post,versions:[{...post,text:'旧内容',createdAt:'2025-01-01T00:00:00Z',contentHash:'1234abcdef123456',images:[]},{...post,text:'不完整观察',contentHash:'abababab12345678',observationOnly:true,fullText:false,images:[]}]};
 const entries=buildArchiveEntries({posts:[p,{...post,id:'Rsecond',versions:[{...post,text:'第二个旧版',contentHash:'cdcdcdcd12345678',images:[]}]}]});
 assert.equal(mainNotes(entries).length,1);const histories=entries.filter(e=>e.name.endsWith('-history.md'));assert.equal(histories.length,1);assert.equal(histories[0].name,'微博备份/123456789/2026/2026-11-history.md');assert.match(histories[0].data,/旧内容/);assert.match(histories[0].data,/不完整观察/);assert.match(histories[0].data,/2025-01-01/);
 assert.equal(manifest(entries).exportedPostCount,2);assert.equal(manifest(entries).exportedVersionCount,3);assert.equal(manifest(entries).historyNoteCount,1);
});
test('current, historical and unknown note image references resolve to real entries',()=>{
 const p={...post,versions:[{...post,text:'old',contentHash:'1234abcd1234abcd'}]};
 const entries=buildArchiveEntries({posts:[p,{...post,id:'Runknown',createdAt:null,versions:[{...post,id:'Runknown',createdAt:null}]}],media:mediaFor(post)});const names=new Set(entries.map(e=>e.name));
 for(const note of entries.filter(e=>e.name.endsWith('.md')))for(const m of note.data.matchAll(/!\[图片 \d+\]\(([^)]+)\)/g))assert.ok(names.has(path.posix.normalize(path.posix.join(path.posix.dirname(note.name),m[1]))),`${note.name}: ${m[1]}`);
 assert.doesNotThrow(()=>buildZip(entries));
});
test('version attachment folders do not collide with a different post ID suffix',()=>{
 const p={...post,id:'Rone',versions:[{...post,id:'Rone',contentHash:'1234abcd'}]};const entries=buildArchiveEntries({posts:[p,{...post,id:'Rone-v1'}],media:mediaFor(post)});assert.doesNotThrow(()=>buildZip(entries));
});
test('text-only export distinguishes deliberately skipped images from failures',()=>{
 const entries=buildArchiveEntries({posts:[post],report:{mode:'text-only'}}),m=manifest(entries);assert.equal(m.failedImageCount,0);assert.equal(m.records[0].requestedImages,0);assert.equal(m.records[0].referencedImages,1);assert.match(mainNotes(entries)[0].data,/纯文字导出/);
});
test('empty input emits no blank monthly note and an explicit zero manifest',()=>{
 const entries=buildArchiveEntries({posts:[]});assert.equal(mainNotes(entries).length,0);assert.equal(manifest(entries).mainNoteCount,0);assert.equal(manifest(entries).exportedPostCount,0);assert.doesNotThrow(()=>buildZip(entries));
});
test('ZIP CRC and structure preserve UTF-8 filenames',async()=>{
 const bytes=new TextEncoder().encode('123456789');assert.equal(crc32(bytes),0xcbf43926);const zip=buildZip([{name:'测试/hello.txt',data:'你好'},{name:'bytes.bin',data:bytes}]);const view=new DataView(zip.buffer);assert.equal(view.getUint32(0,true),0x04034b50);assert.equal(view.getUint16(6,true),0x800);assert.equal(view.getUint32(zip.length-22,true),0x06054b50);assert.equal(view.getUint16(zip.length-12,true),2);if(process.env.WOB_TEST_ZIP)await fs.writeFile(process.env.WOB_TEST_ZIP,zip);
});
test('ZIP rejects traversal, duplicate paths, excessive count and oversized whole month',()=>{
 for(const name of ['../oops','/root.txt','a/../x','a\\x','C:/x','./file','a//b'])assert.throws(()=>buildZip([{name,data:''}]),/路径/);
 assert.throws(()=>buildZip([{name:'a',data:''},{name:'a',data:''}]),/重复/);assert.throws(()=>buildZip(Array(65536).fill({name:'a',data:''})),/数量/);
 assert.throws(()=>buildZip([{name:'huge-month.bin',data:new Uint8Array(MAX_ARCHIVE_BYTES)}]),/128 MB/);
});

test('month-directory layout keeps notes, current images and history in one self-contained folder',()=>{
 const p={...post,versions:[{...post,text:'去年旧内容',createdAt:'2025-01-01T00:00:00Z',contentHash:'old-snapshot'}]},before=structuredClone(p);
 const entries=buildArchiveEntries({posts:[p],media:mediaFor(p),layout:'month-directory'}),names=new Set(entries.map(entry=>entry.name));
 assert.deepEqual([...names].sort(),[
  '2026-11/2026-11.md','2026-11/2026-11-history.md','2026-11/assets/Rpabc123/01.jpg',
  '2026-11/assets/Rpabc123/versions/1/01.jpg','2026-11/manifest.json','2026-11/导入说明.md',
 ].sort());
 const m=JSON.parse(entries.find(entry=>entry.name==='2026-11/manifest.json').data);
 assert.equal(m.archiveLayout,MONTH_DIRECTORY_LAYOUT);assert.equal(m.months[0].path,'2026-11/2026-11.md');
 assert.equal(m.months[0].historyPath,'2026-11/2026-11-history.md');assert.equal(m.savedImageCount,2);
 assert.equal(m.records[1].month,'2026-11','historical dates stay with the current saved month');
 assert.match(entries.find(entry=>entry.name.endsWith('-history.md')).data,/2025-01-01/);
 for(const record of m.records){const note=entries.find(entry=>entry.name===record.path);assert.ok(note);assert.ok(note.data.includes(`^${record.anchor}`));}
 for(const note of entries.filter(entry=>entry.name.endsWith('.md'))){
  for(const match of note.data.matchAll(/!?\[(?:图片 \d+|查看本月历史观察|返回本月主笔记)\]\(([^)]+)\)/g)){
   assert.ok(!match[1].startsWith('../'));assert.ok(names.has(path.posix.join(path.posix.dirname(note.name),match[1])),`${note.name}: ${match[1]}`);
  }
 }
 assert.match(entries.find(entry=>entry.name==='2026-11/2026-11.md').data,/\[查看本月历史观察\]\(2026-11-history.md\)/);
 assert.match(entries.find(entry=>entry.name==='2026-11/2026-11-history.md').data,/\[返回本月主笔记\]\(2026-11.md\)/);
 assert.deepEqual(p,before);assert.doesNotThrow(()=>buildZip(entries));
});

test('unknown month directory keeps all local links and manifest paths within 未知日期',()=>{
 const p={...post,createdAt:null,versions:[{...post,contentHash:'old-snapshot'}]};
 const entries=buildArchiveEntries({posts:[p],media:mediaFor(p),layout:'month-directory'}),names=new Set(entries.map(entry=>entry.name));
 assert.ok(entries.every(entry=>entry.name.startsWith('未知日期/')));assert.ok(names.has('未知日期/未知日期.md'));
 const m=JSON.parse(entries.find(entry=>entry.name==='未知日期/manifest.json').data);
 assert.equal(m.months[0].month,'unknown');assert.equal(m.months[0].historyPath,'未知日期/未知日期-history.md');
 for(const note of entries.filter(entry=>entry.name.endsWith('.md')))for(const match of note.data.matchAll(/!?\[(?:图片 \d+|查看本月历史观察|返回本月主笔记)\]\(([^)]+)\)/g))
  assert.ok(names.has(path.posix.join(path.posix.dirname(note.name),match[1])));
 assert.doesNotThrow(()=>buildZip(entries));
});

test('month-directory scope rejects empty, mixed accounts, mixed months and unsafe IDs before creating entries',()=>{
 for(const posts of [[],[post,{...post,uid:'987654321'}],[post,{...post,id:'Rother',createdAt:'2026-10-01T00:00:00Z'}],
  [post,{...post,createdAt:'2026-10-01T00:00:00Z'}],[post,{...post,id:'Runknown',createdAt:null}]])
  assert.throws(()=>buildArchiveEntries({posts,layout:'month-directory'}),/同一账号同一个月/);
 for(const bad of [{...post,id:'../escape'},{...post,uid:'../escape'}])assert.throws(()=>buildArchiveEntries({posts:[bad],layout:'month-directory'}),/不合法/);
 assert.throws(()=>buildArchiveEntries({posts:[post],layout:'../../escape'}),/布局/);
 const entries=buildArchiveEntries({posts:[post,post],layout:'month-directory',report:{mode:'text-only',month:'../../escape',snapshotMonth:'../other',archiveLayout:'wrong'}});
 assert.ok(entries.every(entry=>entry.name.startsWith('2026-11/')));
 assert.equal(entries.filter(entry=>entry.name.endsWith('/2026-11.md')).length,1);
 const m=JSON.parse(entries.find(entry=>entry.name==='2026-11/manifest.json').data);assert.equal(m.exportedPostCount,1);assert.equal(m.archiveLayout,MONTH_DIRECTORY_LAYOUT);
});
