import {dateParts} from './dates.js';
import {normalizeExportMediaURL} from './media-data.js';
/** Pure, dependency-free monthly Markdown and ZIP export. Inputs are untrusted. */
const encoder = new TextEncoder();
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MONTH_DIRECTORY_LAYOUT = 'month-directory-v2';
const MIME_EXTENSIONS = new Map([['image/jpeg','jpg'],['image/png','png'],['image/gif','gif'],['image/webp','webp'],['image/avif','avif']]);
const yaml = value => JSON.stringify(String(value ?? ''));
const escapeText = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}\[\]()#!|~^])/g,'\\$1');
const lineText = value => escapeText(String(value ?? '').replace(/[\r\n]+/g,' '));
function safeId(value,label){const id=String(value??'');if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error(`${label} 不合法，无法安全导出`);return id}
function sanitizedUrl(raw,allowedHosts){try{const url=new URL(String(raw));if(url.protocol!=='https:'||url.username||url.password||!allowedHosts.some(h=>url.hostname===h||url.hostname.endsWith(`.${h}`)))return '';url.search='';url.hash='';return url.toString().replace(/[()\[\]]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}catch{return ''}}
const sourceUrl=raw=>sanitizedUrl(raw,['weibo.com','weibo.cn']);
const imageUrl=raw=>sanitizedUrl(normalizeExportMediaURL(raw),['sinaimg.cn','img.t.sinajs.cn','face.t.sinajs.cn']);
const hex=value=>[...encoder.encode(value)].map(n=>n.toString(16).padStart(2,'0')).join('');
/** Stable valid Obsidian block ID, injective even for underscores/hyphens. */
export function postAnchor(post){return `weibo-${hex(safeId(post.uid,'账号 UID'))}-${hex(safeId(post.id,'微博 ID'))}`}
const validImagePath=path=>typeof path==='string'&&/^(?:\.\.\/)?assets\/[A-Za-z0-9_-]+\/(?:versions\/\d+\/)?\d+\.(jpg|png|gif|webp|avif)$/.test(path);

/** Renders an entry fragment inside a monthly note; not a per-post note. */
export function renderMarkdown(post,imagePaths=[],options={}){
  const uid=safeId(post.uid,'账号 UID'),id=safeId(post.id,'微博 ID'),source=sourceUrl(post.url),date=dateParts(post.createdAt);
  const images=imagePaths.filter(validImagePath),anchor=options.anchor||postAnchor(post);
  if(!/^[A-Za-z0-9-]+$/.test(anchor))throw new Error('不安全的条目锚点');
  const lines=[`## ${date?.display||'日期未知'} · ${lineText(id)}`,'',`微博条目 ${lineText(uid)} / ${lineText(id)} ^${anchor}`,'',
    `- 作者：${lineText(post.author||uid)}`,`- 发布时间（北京时间）：${date?.display||'未知'}${post.dateApproximate?'（估计）':''}`,`- 原始日期：${lineText(post.dateRaw)}`,
    `- 正文完整性：${post.fullText===true?'已取得当前可见正文':'未确认完整'}`,`- 是否转发：${post.isRepost===true?'是':'否'}`,
    `- 首次备份：${lineText(post.firstSeenAt)}`,`- 最近观察：${lineText(post.lastSeenAt)}`,`- 内容指纹：${lineText(post.contentHash)}`,'',escapeText(post.text),''];
  if(post.observationOnly)lines.push('> 此条是后来采集到的不完整观察，不代表完整版本。','');
  if((post.versions||[]).some(v=>v.observationOnly))lines.push('存在后来采集到的不完整观察，请结合本月历史档阅读；当前正文可能保留较完整的旧快照。','');
  if(post.isRepost){lines.push('### 转发内容','',post.repostText?escapeText(post.repostText):'未能取得被转发原文。','');const quote=sourceUrl(post.repostUrl);if(quote)lines.push(`[查看被转发原文](${quote})`,'')}
  if(images.length)lines.push('### 本地图片','',...images.flatMap((p,i)=>[`![图片 ${i+1}](${p})`,'']));
  if(post.fullText!==true)lines.push('> 正文完整性未确认：可能尚未展开全文，或接口未提供完整内容。','');
  if(post._imagesRequested===false&&(post.images||[]).length)lines.push('本次为纯文字导出，未包含图片文件。','');
  if(source)lines.push(`[查看微博原文](${source})`,'');
  return lines.join('\n');
}
function sanitizeReport(report={}){
  const out={};for(const key of ['status','stopReason','startedAt','finishedAt','exportedAt','fromDate','toDate','mode','month','exportUnit','snapshotMonth'])if(typeof report[key]==='string')out[key]=report[key].slice(0,1000);
  for(const key of ['scanned','saved','unparsed','pages','rounds','failedImages','legacyUnresolvedRecords'])if(Number.isFinite(report[key]))out[key]=report[key];
  if(Array.isArray(report.failures))out.attachmentFailures=report.failures.map(f=>({url:imageUrl(f.url),reason:String(f.reason||'未知失败').slice(0,500)}));return out;
}
function comparePosts(a,b){const da=dateParts(a.createdAt),db=dateParts(b.createdAt);return (da?.time??Infinity)-(db?.time??Infinity)||String(a.id).localeCompare(String(b.id))}
function noteHeader(group,history,count,layout){return ['---','platform: "weibo"',`archive_layout: ${yaml(layout)}`,`author_uid: ${yaml(group.uid)}`,`month: ${yaml(group.month)}`,`note_type: ${yaml(history?'history-observations':'monthly-current')}`,`entry_count: ${count}`,'timezone: "Asia/Shanghai"','all_history_guaranteed: false','---','',`# ${group.month==='unknown'?'未知日期':group.month} · 微博${history?'历史观察':'备份'}`,'',history?'这里保留本月当前记录关联的旧版本与不完整观察；每条仍显示其原始发布时间。不代表源站完整编辑历史。':'本页汇总该月当前已保存的微博，按北京时间从早到晚排列。视频文件和评论区未包含。','', '此文件是独立备份快照，不会自动合并 Obsidian 批注；再次导入前请备份或另存旧文件。',''].join('\n')}

export function buildArchiveEntries({posts=[],media=new Map(),report={},layout='monthly-v1'}={}){
  if(!Array.isArray(posts))throw new Error('posts 必须是数组');if(!(media instanceof Map))throw new Error('media 必须是 Map');
  if(!['monthly-v1','month-directory'].includes(layout))throw new Error('不支持的 Markdown 归档布局');
  const monthDirectory=layout==='month-directory',archiveLayout=monthDirectory?MONTH_DIRECTORY_LAYOUT:'monthly-v1';
  const entries=[],records=[],groups=new Map(),seen=new Set(),scopes=new Set(),imagesRequested=report.mode!=='text-only';
  for(const post of posts){const uid=safeId(post.uid,'账号 UID'),id=safeId(post.id,'微博 ID'),identity=`${uid}:${id}`,date=dateParts(post.createdAt),month=date?.month||'unknown',key=`${uid}:${month}`;scopes.add(key);if(seen.has(identity))continue;seen.add(identity);if(!groups.has(key))groups.set(key,{uid,month,year:date?.year,posts:[]});groups.get(key).posts.push(post)}
  if(monthDirectory&&scopes.size!==1)throw new Error('月份目录归档必须包含同一账号同一个月的非空快照');
  const monthRecords=[];
  for(const group of [...groups.values()].sort((a,b)=>a.uid.localeCompare(b.uid)||a.month.localeCompare(b.month))){
    group.posts.sort(comparePosts);const file=group.month==='unknown'?'未知日期':group.month,root=monthDirectory?file:`微博备份/${group.uid}`;
    const folder=!monthDirectory&&group.year?`${root}/${group.year}`:root,notePath=`${folder}/${file}.md`,historyPath=`${folder}/${file}-history.md`,relativeBase=!monthDirectory&&group.year?'../':'';
    const currentFragments=[],historyFragments=[];
    const addEntry=(post,versionIndex=0)=>{
      const id=safeId(post.id,'微博 ID'),assetId=versionIndex?`${id}/versions/${versionIndex}`:id,images=[],failures=[];
      const version=versionIndex?String(post.contentHash||`snapshot-${versionIndex}`):null;
      const anchor=`${postAnchor(post)}${versionIndex?`-v${versionIndex}`:''}`,path=versionIndex?historyPath:notePath;
      for(const [index,url]of(imagesRequested?[...new Set(post.images||[])]:[]).entries()){
        const item=media.get(url),ext=MIME_EXTENSIONS.get(item?.mime?.toLowerCase().split(';')[0].trim());
        if(!imageUrl(url)||!item||!(item.bytes instanceof Uint8Array)||!item.bytes.length||!ext){failures.push({url:imageUrl(url),reason:!imageUrl(url)?'图片来源不受支持':'图片未下载或格式不受支持'});continue}
        const filename=`${String(index+1).padStart(2,'0')}.${ext}`;entries.push({name:`${root}/assets/${assetId}/${filename}`,data:item.bytes});images.push(`${relativeBase}assets/${assetId}/${filename}`);
      }
      const fragment=renderMarkdown({...post,_imagesRequested:imagesRequested},images,{anchor});(versionIndex?historyFragments:currentFragments).push(fragment);
      records.push({id,uid:group.uid,month:group.month,version,path,anchor,source:sourceUrl(post.url),createdAt:post.createdAt||null,fullText:post.fullText===true,observationOnly:post.observationOnly===true,referencedImages:[...new Set(post.images||[])].length,requestedImages:imagesRequested?[...new Set(post.images||[])].length:0,savedImages:images.length,failedImages:failures});
    };
    for(const post of group.posts){addEntry(post);for(const [i,version]of(Array.isArray(post.versions)?post.versions:[]).entries())addEntry({...version,id:post.id,uid:post.uid},i+1)}
    entries.push({name:notePath,data:noteHeader(group,false,currentFragments.length,archiveLayout)+(monthDirectory&&historyFragments.length?`\n[查看本月历史观察](${file}-history.md)\n\n`:'')+currentFragments.join('\n\n---\n\n')});
    if(historyFragments.length)entries.push({name:historyPath,data:noteHeader(group,true,historyFragments.length,archiveLayout)+(monthDirectory?`\n[返回本月主笔记](${file}.md)\n\n`:'')+historyFragments.join('\n\n---\n\n')});
    monthRecords.push({uid:group.uid,month:group.month,path:notePath,postCount:currentFragments.length,historyPath:historyFragments.length?historyPath:null,historyCount:historyFragments.length});
  }
  const manifest={schemaVersion:2,archiveLayout,...sanitizeReport(report),mainNoteCount:monthRecords.length,historyNoteCount:monthRecords.filter(m=>m.historyPath).length,months:monthRecords,exportedPostCount:records.filter(r=>!r.version).length,exportedVersionCount:records.filter(r=>r.version).length,completeTextCount:records.filter(r=>r.fullText).length,savedImageCount:records.reduce((n,r)=>n+r.savedImages,0),failedImageCount:records.reduce((n,r)=>n+r.failedImages.length,0),allHistoryGuaranteed:false,videoFilesIncluded:false,records};
  const metadataRoot=monthDirectory?(monthRecords[0].month==='unknown'?'未知日期':monthRecords[0].month):'微博备份';
  entries.push({name:`${metadataRoot}/manifest.json`,data:JSON.stringify(manifest,null,2)});
  entries.push({name:`${metadataRoot}/导入说明.md`,data:'# 每月一篇微博备份\n\n'+(monthDirectory?'每个月是一个独立目录，目录内有主笔记、可选的历史观察笔记、assets 图片目录和本月清单。解压一次即可阅读；请整体保留月份目录。\n\n':'')+'将此文件夹放入 Obsidian 仓库，保留 assets 相对目录。每个已知月份只有一篇主笔记；未知日期集中在 未知日期.md，不猜测归月。\n\n条目带稳定块 ID，可用 [[月笔记路径#^块ID]] 引用。每月的 -history.md 保存该月当前记录关联的旧版本/不完整观察，不是源站全部编辑历史。\n\n月增量导出应包含该月本地当前已保存的完整集合，而非仅新增几条；并不证明源站月份已完整抓取。再次导入前请新建快照目录，或先备份旧文件再手工合并。不要直接覆盖写过批注的月笔记，本工具不自动合并批注。\n\nmanifest.json 列出本包月份、条目、正文完整性与图片失败。视频文件和评论区不在备份内。正文按转义文字保存，不执行原页面 HTML，不加载缺失图片的远程外链。\n'});
  return entries;
}
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let crc = n; for (let i = 0; i < 8; i++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; crcTable[n] = crc >>> 0; }
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

/** ZIP STORE format, UTF-8 names, no external dependency or executable content. */
export function buildZip(entries) {
  if (!Array.isArray(entries) || entries.length > 65535) throw new Error('ZIP 文件数量过多；月备份不可拆成日或条目批次，请尝试整月纯文字导出');
  const prepared = [], seen = new Set();
  let total = 22;
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || /[\\\0]/.test(entry.name) || entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name) || entry.name.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('不安全的 ZIP 文件路径');
    if (seen.has(entry.name)) throw new Error('ZIP 内有重复文件路径');
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const bytes = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (!(bytes instanceof Uint8Array) || name.length > 65535 || bytes.length > 0xffffffff) throw new Error('ZIP 文件不受支持');
    total += 30 + name.length + bytes.length + 46 + name.length;
    if (total > MAX_ARCHIVE_BYTES || total > 0xffffffff) throw new Error('单个 ZIP 超过 128 MB；月备份必须保持整月，请尝试整月纯文字导出，不要缩小到几天覆盖月笔记');
    prepared.push({ name, bytes, crc: crc32(bytes) });
  }
  const output = new Uint8Array(total), view = new DataView(output.buffer);
  let offset = 0;
  const u16 = (at, value) => view.setUint16(at, value, true);
  const u32 = (at, value) => view.setUint32(at, value, true);
  for (const entry of prepared) {
    entry.offset = offset;
    u32(offset, 0x04034b50); u16(offset + 4, 20); u16(offset + 6, 0x0800);
    u16(offset + 10, 0); u16(offset + 12, 33); // 1980-01-01, deterministic archive metadata
    u32(offset + 14, entry.crc); u32(offset + 18, entry.bytes.length); u32(offset + 22, entry.bytes.length);
    u16(offset + 26, entry.name.length);
    output.set(entry.name, offset + 30); output.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    u32(offset, 0x02014b50); u16(offset + 4, 20); u16(offset + 6, 20); u16(offset + 8, 0x0800);
    u16(offset + 12, 0); u16(offset + 14, 33);
    u32(offset + 16, entry.crc); u32(offset + 20, entry.bytes.length); u32(offset + 24, entry.bytes.length);
    u16(offset + 28, entry.name.length); u32(offset + 42, entry.offset);
    output.set(entry.name, offset + 46); offset += 46 + entry.name.length;
  }
  const centralSize = offset - centralOffset;
  u32(offset, 0x06054b50); u16(offset + 8, prepared.length); u16(offset + 10, prepared.length);
  u32(offset + 12, centralSize); u32(offset + 16, centralOffset);
  return output;
}
