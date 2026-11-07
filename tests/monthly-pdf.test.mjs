import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMonthlyPdf,buildCombinedPdf,printableText,wrapPdfText,wrapPdfInlineText} from '../extension/monthly-pdf.js';
import {PDFDocument,PDFName,decodePDFRawStream} from '../extension/vendor/pdf-lib.esm.min.js';

const fontBytes=new Uint8Array(readFileSync(new URL('../extension/fonts/NotoSansSC-Regular.ttf',import.meta.url)));
const uid='1234567890';
const post=(id,extra={})=>({uid,id,author:'示例账号',createdAt:'2026-11-06T02:30:00Z',text:'中文原创内容。Hello PDF!',fullText:true,isRepost:false,images:[],versions:[],url:`https://weibo.com/${uid}/${id}`,...extra});
const batch=posts=>({uid,month:'2026-11',posts});
const pixelPng=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYqkAAAAASUVORK5CYII=','base64'));
const pixelJpeg=new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z','base64'));

// 浏览器解码由测试替身控制，真实 JPEG 验证最终 PDF 走 DCT 压缩而不是保留 RGB。
function mockImageCanvas(t,{width=8000,height=4000,failEncode=false}={}){
  const previousBitmap=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap'),previousCanvas=Object.getOwnPropertyDescriptor(globalThis,'OffscreenCanvas');
  const calls={decoded:0,closed:0,canvases:[],draws:[],encodes:[]};
  globalThis.createImageBitmap=async blob=>{calls.decoded++;calls.mime=blob.type;return {width,height,close(){calls.closed++}}};
  globalThis.OffscreenCanvas=class {
    constructor(w,h){this.width=w;this.height=h;calls.canvases.push({width:w,height:h,canvas:this})}
    getContext(){return {fillRect(){},drawImage(...args){calls.draws.push(args)}}}
    async convertToBlob(options){calls.encodes.push(options);if(failEncode)throw new Error('encoding failed');return new Blob([pixelJpeg],{type:'image/jpeg'})}
  };
  t.after(()=>{if(previousBitmap)Object.defineProperty(globalThis,'createImageBitmap',previousBitmap);else delete globalThis.createImageBitmap;if(previousCanvas)Object.defineProperty(globalThis,'OffscreenCanvas',previousCanvas);else delete globalThis.OffscreenCanvas});
  return calls;
}

function pngHeader(width,height){
  const bytes=pixelPng.slice(),view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);return bytes;
}

// 读取 PDF 内字体 ToUnicode 映射与文本操作符，验证实际输出文字而不是仅检查文件头。
function extractText(document){
  return document.getPages().map(page=>{
    const mapping=new Map(),fonts=page.node.Resources().lookup(PDFName.of('Font'));
    for(const [,ref] of fonts.entries()){
      const stream=document.context.lookup(ref).lookup(PDFName.of('ToUnicode'));
      if(!stream)continue;
      const cmap=new TextDecoder().decode(decodePDFRawStream(stream).decode());
      for(const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const pair of block[1].matchAll(/<([0-9A-F]+)>\s*<([0-9A-F]+)>/gi)){
        const chars=pair[2].match(/.{4}/g)||[];
        mapping.set(pair[1].toUpperCase(),String.fromCharCode(...chars.map(value=>parseInt(value,16))));
      }
    }
    const contents=page.node.Contents(),refs=contents.asArray?contents.asArray():[contents];
    return refs.map(ref=>{
      const text=new TextDecoder().decode(decodePDFRawStream(document.context.lookup(ref)).decode());
      return [...text.matchAll(/<([0-9A-F]+)>\s*Tj/gi)].map(match=>(match[1].match(/.{4}/g)||[]).map(glyph=>mapping.get(glyph.toUpperCase())||'').join('')).join('\n');
    }).join('\n');
  }).join('\n');
}

function annotations(document){
  return document.getPages().flatMap((page,pageIndex)=>(page.node.Annots()?.asArray()||[]).map(ref=>{
    const annotation=document.context.lookup(ref),action=annotation.lookup(PDFName.of('A'));
    return {pageIndex,url:action.lookup(PDFName.of('URI')).decodeText(),
      rect:annotation.lookup(PDFName.of('Rect')).asArray().map(value=>value.asNumber())};
  }));
}

test('PDF uses named hyperlinks for saved mentions and adjacent topics without printing encoded destinations',async()=>{
  const name='示例访客',mention=`https://weibo.com/n/${encodeURIComponent(name)}`;
  const supertopic='https://weibo.com/p/1008080123456789abcdef0123456789abcdef';
  const topic='https://s.weibo.com/weibo?q='+encodeURIComponent('#街角漫步#')+'&from=synthetic#results';
  const text=`今天遇见@${name} (${mention})。\n在这里留下记录。 合成旅行超话 (${supertopic})#街角漫步# (${topic})\n末尾正文完整保留。`;
  const result=await buildMonthlyPdf(batch([post('NamedLinks',{text})]),{fontBytes});
  const document=await PDFDocument.load(result.bytes),output=extractText(document),links=annotations(document);
  assert.match(output,/@示例访客/);assert.match(output,/合成旅行超话/);assert.match(output,/#街角漫步#/);
  assert.match(output,/末尾正文完整保留/);assert.match(output,/查看微博原文/);
  assert.doesNotMatch(output,/https?:|%[0-9A-F]{2}|1008080123456789/);
  assert.deepEqual(new Set(links.map(link=>link.url)),new Set([mention,supertopic,topic,`https://weibo.com/${uid}/NamedLinks`]));
});

test('a long named hyperlink remains clickable on every wrapped line and across page boundaries',async()=>{
  const label=`#${'跨页话题'.repeat(150)}#`,target='https://s.weibo.com/weibo?q=%23synthetic-long-topic%23';
  const text=Array.from({length:17},()=> '前面的普通正文。').join('\n')+`\n${label} (${target})\n全部末尾仍然保留。`;
  const result=await buildMonthlyPdf(batch([post('WrappedLink',{text})]),{fontBytes});
  const document=await PDFDocument.load(result.bytes),output=extractText(document),links=annotations(document).filter(link=>link.url===target);
  assert.ok(result.pageCount>=2);assert.ok(links.length>10);
  assert.ok(new Set(links.map(link=>link.pageIndex)).size>=2,'link fragments must continue onto the next page');
  for(const {rect:[left,bottom,right,top]} of links){
    assert.ok(left>=48&&right<=547.29&&right>left);
    assert.ok(bottom>=55&&top<=841.89&&top>bottom);
  }
  const continuous=output.split('\n').filter(line=>!line.includes('· 原创微博 · UID')&&!line.includes('仅原创 · 时间为北京时间')&&!/^\d+ \/ \d+$/.test(line)).join('');
  assert.equal((continuous.match(/跨页话题/g)||[]).length,150);
  assert.match(output,/全部末尾仍然保留/);assert.doesNotMatch(output,/https?:|synthetic-long-topic/);
});

test('a short post keeps its heading, blank paragraphs and final sentence together near the page bottom',async()=>{
  const filler=Array.from({length:18},()=> '前一条填充正文。').join('\n');
  const ending='最后一句应与条目标题留在同页。';
  const result=await buildMonthlyPdf(batch([
    post('Filler',{text:filler}),
    post('ShortPost',{createdAt:'2026-11-07T02:30:00Z',dateApproximate:true,text:`短条目第一段。\n短条目第二段。\n\n${ending}`}),
  ]),{fontBytes});
  const document=await PDFDocument.load(result.bytes);
  const pageTexts=document.getPages().map(page=>extractText({context:document.context,getPages:()=>[page]}));
  const headingPage=pageTexts.findIndex(text=>text.includes('2026-11-07 10:30:00'));
  const endingPage=pageTexts.findIndex(text=>text.includes(ending));
  assert.equal(result.pageCount,2);assert.equal(headingPage,1,'the short post should move intact to the next page');
  assert.equal(endingPage,headingPage);assert.match(pageTexts[headingPage],/短条目第一段/);
});

test('a new month section stays with its short first post instead of ending the preceding page alone',async()=>{
  const ending='新月份的末句也要完整保留。';
  const result=await buildCombinedPdf([
    {uid,month:'2026-10',posts:[post('EarlierMonth',{createdAt:'2026-10-07T02:30:00Z',text:Array.from({length:13},()=> '上一月份填充正文。').join('\n')})]},
    batch([post('NewMonth',{dateApproximate:true,text:`新月份第一段。\n新月份第二段。\n\n${ending}`})]),
  ],{fontBytes});
  const document=await PDFDocument.load(result.bytes);
  const pageTexts=document.getPages().map(page=>extractText({context:document.context,getPages:()=>[page]}));
  const monthPage=pageTexts.findIndex(text=>text.includes('2026 年 11 月'));
  const headingPage=pageTexts.findIndex(text=>text.includes('2026-11-06 10:30:00'));
  const endingPage=pageTexts.findIndex(text=>text.includes(ending));
  assert.equal(result.pageCount,2);assert.equal(monthPage,1);
  assert.equal(headingPage,monthPage);assert.equal(endingPage,monthPage);
});

test('linked emoji keep their text semantics while unsafe destinations remain inert visible text',async()=>{
  const name='示例小猫🐈',target=`https://weibo.com/n/${encodeURIComponent(name)}`;
  const text=`谢谢@${name} (${target})。\n查看详情 (javascript:alert(1))\n查看详情 (https://user:pass@example.test/)`;
  const result=await buildMonthlyPdf(batch([post('LinkSafety',{text})]),{fontBytes,emojiRenderer:async()=>pixelPng});
  const document=await PDFDocument.load(result.bytes),output=extractText(document),links=annotations(document);
  assert.equal(result.failedUnicodeEmojiCount,0);assert.equal(result.savedEmojiCount,1);
  assert.equal(links.filter(link=>link.url===target).length,1);
  assert.ok(links.every(link=>!link.url.includes('javascript:')&&!link.url.includes('user:pass')));
  assert.match(output,/javascript:alert\(1\)/);assert.match(output,/user:pass@example.test/);
  const commands=document.getPages().flatMap(page=>page.node.Contents().asArray().map(ref=>new TextDecoder().decode(decodePDFRawStream(document.context.lookup(ref)).decode()))).join('\n');
  assert.equal((commands.match(/ActualText/g)||[]).length,1);
});

test('hidden link targets do not request emoji rendering or report missing emoticon attachments',async()=>{
  const target='https://example.test/🦄/[笑cry]',face='https://face.t.sinaimg.cn/hidden-missing.png',rendered=[];
  const result=await buildMonthlyPdf(batch([post('HiddenEmoji',{text:`正文 查看详情 (${target})\n保留末尾。`,emoticons:[{text:'[笑cry]',url:face}]})]),{
    fontBytes,images:true,emojiRenderer:async cluster=>{rendered.push(cluster);throw new Error('no emoji font');},
  });
  assert.deepEqual(rendered,[]);assert.equal(result.savedEmojiCount,0);assert.equal(result.failedUnicodeEmojiCount,0);
  assert.equal(result.failedEmojiCount,0);assert.equal(result.failedImageCount,0);
  assert.deepEqual(result.attachmentFailures,[]);assert.deepEqual(result.failedMediaUrls,[]);assert.deepEqual(result.missingGlyphs,[]);
  const document=await PDFDocument.load(result.bytes),output=extractText(document);
  assert.match(output,/查看详情/);assert.match(output,/保留末尾/);assert.doesNotMatch(output,/\[U\+|笑cry|表情未能嵌入/);
  assert.ok(annotations(document).some(link=>link.url===new URL(target).href));
});

test('visible linked names retain emoji failure diagnostics without counting the hidden destination twice',async()=>{
  const name='示例小猫🐈',target=`https://weibo.com/n/${name}`,rendered=[];
  const result=await buildMonthlyPdf(batch([post('VisibleEmoji',{text:`谢谢@${name} (${target})。`})]),{
    fontBytes,emojiRenderer:async cluster=>{rendered.push(cluster);throw new Error('no emoji font');},
  });
  assert.deepEqual(rendered,['🐈']);assert.equal(result.failedUnicodeEmojiCount,1);assert.equal(result.failedEmojiCount,1);
  assert.equal(result.attachmentFailures.length,1);assert.equal(result.attachmentFailures[0].kind,'unicode');
  const document=await PDFDocument.load(result.bytes),output=extractText(document);
  assert.match(output,/@示例小猫\[U\+1F408\]/);
  assert.ok(annotations(document).some(link=>link.url===new URL(target).href));
});

test('visible linked emoticon labels keep their attachment diagnostics without counting hidden URL labels',async()=>{
  const face='https://face.t.sinaimg.cn/visible-missing.png';
  const result=await buildMonthlyPdf(batch([post('VisibleEmoticon',{text:'正文 [笑cry] (https://example.test/[笑cry])。',emoticons:[{text:'[笑cry]',url:face}]})]),{fontBytes,images:true});
  assert.equal(result.failedEmojiCount,1);assert.equal(result.failedImageCount,1);assert.equal(result.failedUnicodeEmojiCount,0);
  assert.equal(result.attachmentFailures.length,1);assert.equal(result.attachmentFailures[0].kind,'emoticon');
  assert.deepEqual(result.failedMediaUrls,[face]);
  const output=extractText(await PDFDocument.load(result.bytes));
  assert.match(output,/\[笑cry\]/);assert.match(output,/有 1 个表情未能嵌入/);assert.doesNotMatch(output,/https?:/);
});

test('PDF rejects reposts, wrong accounts and cross-month records before generation',async()=>{
  for(const bad of [post('A',{isRepost:true}),post('A',{repostText:'引用'}),post('A',{uid:'99'}),post('A',{createdAt:'2026-10-01T00:00:00Z'})])await assert.rejects(buildMonthlyPdf(batch([bad]),{fontBytes}),/原创|月份/);
  await assert.rejects(buildMonthlyPdf(batch([]),{fontBytes}),/没有/);
});

test('PDF embeds searchable Chinese, chronological order and clickable source links',async()=>{
  const later=post('Later',{text:'后发布的原创',createdAt:'2026-11-07T00:00:00Z'}),earlier=post('Earlier',{text:'先发布的原创',url:`https://weibo.com/${uid}/Earlier?token=private#secret`,versions:[{text:'历史内容不应出现'}]});
  const result=await buildMonthlyPdf(batch([later,earlier]),{fontBytes});
  const document=await PDFDocument.load(result.bytes),text=extractText(document);
  assert.match(text,/2026 年 11 月/);assert.match(text,/先发布的原创/);assert.ok(text.indexOf('先发布的原创')<text.indexOf('后发布的原创'));
  assert.doesNotMatch(text,/历史内容不应出现|private|secret|token/);assert.equal(result.postCount,2);assert.equal(result.failedImageCount,0);
  assert.equal(document.getPages()[0].node.Annots().size(),2);
  assert.equal(document.getTitle(),'2026 年 11 月 · 原创微博 - 示例账号');
  const fontRef=document.getPages()[0].node.Resources().lookup(PDFName.of('Font')).values()[0];
  const descendant=document.context.lookup(fontRef).lookup(PDFName.of('DescendantFonts')).lookup(0);
  const embedded=descendant.lookup(PDFName.of('FontDescriptor')).lookup(PDFName.of('FontFile2'));
  assert.equal(decodePDFRawStream(embedded).decode().length,fontBytes.length,'full TrueType embedding prevents the verified subset missing-glyph regression');
});

test('long Chinese text paginates without dropping its final content and numbers every page',async()=>{
  const text='这是需要跨页保留的长正文，不能被截断。'.repeat(260)+'最终文字保留';
  const result=await buildMonthlyPdf(batch([post('Long',{text})]),{fontBytes});
  assert.ok(result.pageCount>2);const document=await PDFDocument.load(result.bytes),output=extractText(document).split('\n').filter(line=>!line.includes('· 原创微博 · UID')&&!line.includes('仅原创 · 时间为北京时间')&&!/^\d+ \/ \d+$/.test(line)).join('');
  assert.match(output,/最终文字保留/);assert.equal((output.match(/这是需要跨页保留的长正文/g)||[]).length,260);
  const fullOutput=extractText(document);for(let page=1;page<=result.pageCount;page++)assert.ok(fullOutput.includes(`${page} / ${result.pageCount}`));
});

test('missing glyphs remain explicit and failed images are counted without claiming success',async()=>{
  const missing=new Set();assert.equal(printableText('A🦄',new Set([65]),missing),'A[U+1F984]');assert.deepEqual([...missing],[0x1f984]);
  const result=await buildMonthlyPdf(batch([post('Media',{text:'含表情🦄',images:['https://wx1.sinaimg.cn/large/missing.jpg']})]),{fontBytes,images:true});
  const text=extractText(await PDFDocument.load(result.bytes));
  assert.equal(result.failedImageCount,1);assert.equal(result.savedImageCount,0);assert.ok(result.missingGlyphs.includes('U+1F984'));assert.match(text,/\[U\+1F984\]/);assert.match(text,/图片 1 未能嵌入/);
  assert.deepEqual(result.failedMediaUrls,['https://wx1.sinaimg.cn/large/missing.jpg']);
  assert.ok(result.attachmentFailures.some(item=>item.postId==='Media'&&item.kind==='image'&&item.url==='https://wx1.sinaimg.cn/large/missing.jpg'));
});

test('valid PNG embeds, text-only ignores media and unknown date does not invent a month',async()=>{
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYqkAAAAASUVORK5CYII=','base64'));
  const url='https://wx1.sinaimg.cn/large/pixel.png',p=post('Image',{images:[url],createdAt:null,dateRaw:'时间不明'}),input={uid,month:'unknown',posts:[p]};
  const result=await buildMonthlyPdf(input,{fontBytes,images:true,media:new Map([[url,{bytes:png,mime:'image/png'}]])});
  assert.equal(result.savedImageCount,1);assert.equal(result.failedImageCount,0);assert.match(extractText(await PDFDocument.load(result.bytes)),/日期未知/);
  const textOnly=await buildMonthlyPdf(input,{fontBytes,images:false});assert.equal(textOnly.failedImageCount,0);assert.equal(textOnly.savedImageCount,0);assert.match(extractText(await PDFDocument.load(textOnly.bytes)),/本次仅导出文字，未包含 1 张图片/);
});

test('wrapping constrains long URLs and preserves explicit blank lines',()=>{
  const font={widthOfTextAtSize:(text,size)=>Array.from(text).length*size};
  const lines=wrapPdfText('abcdefghijk\n\n中文中文',font,10,30);
  assert.deepEqual(lines,['abc','def','ghi','jk','','中文中','文']);
  assert.ok(lines.every(line=>font.widthOfTextAtSize(line,10)<=30));
});

test('invisible formatting from Weibo never becomes missing-glyph boxes or Unicode labels',()=>{
  const text='变化好大!\u200b\u200b\u200b\ufeff\u2060\u200e\u200f\u00ad';
  const supported=new Set(Array.from('变化好大!').map(char=>char.codePointAt(0))),missing=new Set();
  assert.equal(printableText(text,supported,missing),'变化好大!');
  assert.equal(missing.size,0);
  const family='👩‍👩‍👧‍👦';
  assert.equal(printableText(family,supported,missing,new Map([[family,{}]])),family,'an available emoji keeps its ZWJ grapheme intact');
});

test('Unicode emoji are rasterized once per whole grapheme and embedded inline with ActualText',async()=>{
  const family='👩‍👩‍👧‍👦',skin='👍🏽',calls=[];
  const result=await buildMonthlyPdf(batch([post('Emoji',{text:`起始${family}中间${skin}${family}结束\u200b\u200b`})]),{
    fontBytes,emojiRenderer:async cluster=>{calls.push(cluster);return pixelPng;}
  });
  assert.deepEqual(calls,[family,skin]);
  assert.equal(result.savedEmojiCount,3);assert.equal(result.failedUnicodeEmojiCount,0);assert.deepEqual(result.missingGlyphs,[]);
  const document=await PDFDocument.load(result.bytes),text=extractText(document);
  assert.doesNotMatch(text,/\[U\+|部分表情或生僻字/);assert.match(text,/起始/);assert.match(text,/中间/);assert.match(text,/结束/);
  const page=document.getPages()[0],contents=page.node.Contents().asArray().map(ref=>new TextDecoder().decode(decodePDFRawStream(document.context.lookup(ref)).decode())).join('\n');
  assert.equal((contents.match(/ActualText/g)||[]).length,3,'every rendered emoji preserves textual semantics');
  assert.ok(page.node.Resources().lookup(PDFName.of('XObject')).keys().length>=2);
});

test('Weibo image emoticons stay inline, share assets, and are distinct from post photos',async()=>{
  const url='https://face.t.sinaimg.cn/t4/appstyle/expression/ext/normal/face.png';
  const result=await buildMonthlyPdf(batch([post('Emoticon',{text:'今天[笑cry]真的开心[笑cry]',emoticons:[{text:'[笑cry]',url:'https://face.t.sinaimg.cn/expired.png'},{text:'[笑cry]',url},{text:'[笑cry]',url}]})]),{
    fontBytes,images:true,media:new Map([[url,{bytes:pixelPng,mime:'image/png'}]])
  });
  assert.equal(result.savedEmojiCount,2);assert.equal(result.savedImageCount,0);assert.equal(result.failedEmojiCount,0);assert.equal(result.failedImageCount,0);
  assert.deepEqual(result.failedMediaUrls,['https://face.t.sinaimg.cn/expired.png'],'a failed candidate is evictable even when another candidate renders the emoticon');
  assert.deepEqual(result.attachmentFailures,[],'recovered alternatives must not appear as missing attachments');
  const document=await PDFDocument.load(result.bytes),text=extractText(document);
  assert.doesNotMatch(text,/\[笑cry\]|图片 1|未能嵌入/);
  assert.match(text,/今天/);assert.match(text,/真的开心/);
});

test('failed requested emoticons retain alt text, while text-only exports do not claim attachment failures',async()=>{
  const p=post('MissingEmoticon',{text:'保留[笑cry]文字',emoticons:[{text:'[笑cry]',url:'https://face.t.sinaimg.cn/missing.png'}]});
  const failed=await buildMonthlyPdf(batch([p]),{fontBytes,images:true});
  assert.equal(failed.failedEmojiCount,1);assert.equal(failed.failedImageCount,1);assert.equal(failed.failedUnicodeEmojiCount,0);
  assert.equal(failed.attachmentFailures[0].postId,'MissingEmoticon');
  assert.equal(failed.attachmentFailures[0].url,'https://face.t.sinaimg.cn/missing.png');
  assert.match(extractText(await PDFDocument.load(failed.bytes)),/保留\[笑cry\]文字/);
  const textOnly=await buildMonthlyPdf(batch([p]),{fontBytes,images:false});
  assert.equal(textOnly.failedEmojiCount,0);assert.equal(textOnly.failedImageCount,0);
  assert.match(extractText(await PDFDocument.load(textOnly.bytes)),/保留\[笑cry\]文字/);
});

test('a local emoji renderer failure is explicit without confusing it with photo failures',async()=>{
  const result=await buildMonthlyPdf(batch([post('NoEmojiFont',{text:'未知🦄'})]),{fontBytes,emojiRenderer:async()=>{throw new Error('no emoji font');}});
  assert.equal(result.failedUnicodeEmojiCount,1);assert.equal(result.failedEmojiCount,1);assert.equal(result.failedImageCount,0);
  assert.deepEqual(result.failedMediaUrls,[]);
  assert.equal(result.attachmentFailures[0].postId,'NoEmojiFont');
  assert.equal(result.attachmentFailures[0].kind,'unicode');
  assert.ok(result.missingGlyphs.includes('U+1F984'));
  assert.match(extractText(await PDFDocument.load(result.bytes)),/\[U\+1F984\]/);
});

test('inline wrapping treats joined and modified emoji as indivisible units within the text width',()=>{
  const family='👩‍👩‍👧‍👦',font={widthOfTextAtSize:(text,size)=>Array.from(text).length*size};
  const lines=wrapPdfInlineText(`中文${family}后文`,font,10,30,new Map([[family,{width:128,height:128}]]));
  assert.equal(lines.flat().filter(token=>token.emoji===family).length,1);
  assert.ok(lines.every(line=>line.reduce((width,token)=>width+token.width,0)<=30));
  assert.equal(lines.flat().map(token=>token.emoji||token.text).join(''),`中文${family}后文`);
});

test('large PNG photos are decoded once, bounded to 2400 pixels, and embedded as JPEG with bitmap release',async t=>{
  const calls=mockImageCanvas(t),url='https://wx1.sinaimg.cn/large/big.png';
  const p=post('BigPng',{images:[url]}),media=new Map([[url,{bytes:pngHeader(8000,4000),mime:'image/png'}]]);
  const result=await buildMonthlyPdf(batch([p,post('RepeatedPng',{images:[url]})]),{fontBytes,images:true,media});
  assert.equal(result.savedImageCount,2);assert.equal(result.failedImageCount,0);assert.deepEqual(result.failedMediaUrls,[]);
  assert.equal(calls.decoded,1);assert.equal(calls.closed,1);assert.equal(calls.mime,'image/png');
  assert.deepEqual(calls.canvases.map(({width,height})=>[width,height]),[[2400,1200]]);
  assert.equal(calls.canvases[0].canvas.width,1);assert.equal(calls.canvases[0].canvas.height,1);
  assert.deepEqual(calls.encodes,[{type:'image/jpeg',quality:.9}]);
  const document=await PDFDocument.load(result.bytes),xobjects=document.getPages()[0].node.Resources().lookup(PDFName.of('XObject'));
  assert.ok(xobjects.values().every(ref=>String(document.context.lookup(ref).dict.get(PDFName.of('Filter')))==='/DCTDecode'));
});

test('PNG pixel cap rejects before decode, and oversized decoded formats always close their bitmap',async t=>{
  const calls=mockImageCanvas(t,{width:10000,height:5000}),pngUrl='https://wx1.sinaimg.cn/large/oversized.png',gifUrl='https://wx1.sinaimg.cn/large/oversized.gif';
  const media=new Map([[pngUrl,{bytes:pngHeader(10000,5000),mime:'image/png'}],[gifUrl,{bytes:new Uint8Array([71,73,70,56,57,97]),mime:'image/gif'}]]);
  const result=await buildMonthlyPdf(batch([post('Oversized',{images:[pngUrl,gifUrl]})]),{fontBytes,images:true,media});
  assert.equal(result.savedImageCount,0);assert.equal(result.failedImageCount,2);assert.deepEqual(result.failedMediaUrls,[pngUrl,gifUrl]);
  assert.equal(calls.decoded,1,'oversized PNG is rejected by its header before allocating a bitmap');assert.equal(calls.closed,1);assert.equal(calls.canvases.length,0);
});

test('small PNG keeps transparency and conversion failures release the canvas and bitmap for retry',async t=>{
  const calls=mockImageCanvas(t,{failEncode:true}),small='https://face.t.sinaimg.cn/small.png',large='https://wx1.sinaimg.cn/large/broken.png';
  const media=new Map([[small,{bytes:pixelPng,mime:'image/png'}],[large,{bytes:pngHeader(8000,4000),mime:'image/png'}]]);
  const result=await buildMonthlyPdf(batch([post('MixedPng',{text:'保留[表情]',emoticons:[{text:'[表情]',url:small}],images:[large]})]),{fontBytes,images:true,media});
  assert.equal(result.savedEmojiCount,1);assert.equal(result.failedImageCount,1);assert.deepEqual(result.failedMediaUrls,[large]);
  assert.equal(calls.decoded,1,'small PNG is embedded directly without raster conversion');assert.equal(calls.closed,1);
  assert.equal(calls.canvases[0].canvas.width,1);assert.equal(calls.canvases[0].canvas.height,1);
  const document=await PDFDocument.load(result.bytes),xobjects=document.getPages()[0].node.Resources().lookup(PDFName.of('XObject'));
  assert.ok(xobjects.values().every(ref=>String(document.context.lookup(ref).dict.get(PDFName.of('Filter')))==='/FlateDecode'));
});

test('combined PDF sorts all selected months, keeps unknown dates last, and shares one font with continuous numbering',async()=>{
  const october={uid,month:'2026-10',posts:[
    post('OctoberLater',{createdAt:'2026-10-20T00:00:00Z',text:'十月较晚正文'}),
    post('OctoberFirst',{createdAt:'2026-09-30T16:00:00Z',text:'十月最早正文'}),
  ]};
  const november=batch([post('November',{text:'十一月正文',versions:[{text:'历史版本不导出'}]})]);
  const unknown={uid,month:'unknown',posts:[post('Undated',{createdAt:null,dateRaw:'时间不明',text:'未知日期正文'})]};
  const input=[unknown,november,october],before=structuredClone(input),progress=[];
  const result=await buildCombinedPdf(input,{fontBytes,onProgress:value=>progress.push(value)});
  const document=await PDFDocument.load(result.bytes),text=extractText(document);
  assert.equal(document.getTitle(),'合并备份 · 原创微博 - 示例账号');
  assert.equal(result.postCount,4);assert.equal(result.failedImageCount,0);
  assert.match(text,/2026-10 至 2026-11/);assert.match(text,/2026 年 10 月/);assert.match(text,/2026 年 11 月/);assert.match(text,/未知日期/);
  const bodies=['十月最早正文','十月较晚正文','十一月正文','未知日期正文'];
  for(const [index,body] of bodies.entries()){
    assert.equal(text.split(body).length-1,1,'each current body appears once');
    if(index)assert.ok(text.indexOf(bodies[index-1])<text.indexOf(body));
    assert.match(text,new RegExp(`${String(index+1).padStart(2,'0')}  /  `));
  }
  assert.doesNotMatch(text,/历史版本不导出/);
  assert.equal(document.getPages().reduce((sum,page)=>sum+(page.node.Annots()?.size()||0),0),4);
  const fonts=new Set(document.getPages().flatMap(page=>page.node.Resources().lookup(PDFName.of('Font')).values().map(ref=>ref.toString())));
  assert.equal(fonts.size,1,'months share one embedded Chinese font');
  for(let number=1;number<=result.pageCount;number++)assert.ok(text.includes(`${number} / ${result.pageCount}`));
  assert.deepEqual(progress.filter(value=>value.stage==='post').map(value=>value.completed),[1,2,3,4]);
  assert.equal(progress.at(-1).total,4);
  assert.deepEqual(input,before,'rendering must not rearrange saved month snapshots');
});

test('combined PDF retains cross-month images, inline emoji, clickable sources and missing-attachment diagnostics',async()=>{
  const shared='https://wx1.sinaimg.cn/large/shared.png',face='https://face.t.sinaimg.cn/shared.png',missing='https://wx1.sinaimg.cn/large/missing-combined.png';
  const october={uid,month:'2026-10',posts:[post('Picture',{createdAt:'2026-10-01T00:00:00Z',text:'合并图片[笑cry]👍🏽',images:[shared],emoticons:[{text:'[笑cry]',url:face}]})]};
  const november=batch([post('Missing',{text:'第二个月图片',images:[shared,missing]})]);
  const result=await buildCombinedPdf([november,october],{fontBytes,images:true,
    media:new Map([[shared,{bytes:pixelPng,mime:'image/png'}],[face,{bytes:pixelPng,mime:'image/png'}]]),emojiRenderer:async()=>pixelPng});
  const document=await PDFDocument.load(result.bytes),text=extractText(document);
  assert.equal(result.savedImageCount,2);assert.equal(result.savedEmojiCount,2);
  assert.equal(result.failedImageCount,1);assert.equal(result.failedUnicodeEmojiCount,0);
  assert.deepEqual(result.failedMediaUrls,[missing]);
  assert.deepEqual(result.attachmentFailures.map(({postId,url,kind})=>({postId,url,kind})),[{postId:'Missing',url:missing,kind:'image'}]);
  assert.match(text,/合并图片/);assert.match(text,/第二个月图片/);assert.match(text,/图片 2 未能嵌入/);
  assert.doesNotMatch(text,/\[笑cry\]|\[U\+/);
  assert.equal(document.getPages().reduce((sum,page)=>sum+(page.node.Annots()?.size()||0),0),2);
  const objects=new Set(document.getPages().flatMap(page=>page.node.Resources().lookup(PDFName.of('XObject'))?.values().map(ref=>ref.toString())||[]));
  assert.equal(objects.size,3,'the repeated photo shares an object across month sections');
});

test('combined PDF rejects mixed ownership, invalid month membership, duplicate records and aggregate size limits',async()=>{
  const october={uid,month:'2026-10',posts:[post('October',{createdAt:'2026-10-01T00:00:00Z'})]},november=batch([post('November')]);
  for(const invalid of [null,[],[null],[{...november,uid:'bad'}],[{...november,month:'all'}],[{...november,posts:[]}],
    [october,{...november,uid:'9999'}],[{...november,posts:[post('Other',{uid:'9999'})]}],
    [batch([post('Repost',{isRepost:true})])],[batch([post('OldRepost',{versions:[{repostText:'引用正文'}]})])],
    [{...october,posts:november.posts}],[november,november],
    [batch([post('Same'),post('Same')])],[october,batch([post('October')])],[batch([post('')])]]){
    await assert.rejects(buildCombinedPdf(invalid,{fontBytes}));
  }
  await assert.rejects(buildCombinedPdf([{...november,posts:Array(10001).fill(post('TooMany'))}],{fontBytes}),/10000.*每月一份/);
  await assert.rejects(buildCombinedPdf([
    {...october,posts:[{...october.posts[0],text:'文'.repeat(1500001)}]},
    batch([post('Long',{text:'字'.repeat(1500001)})]),
  ],{fontBytes}),/300 万字符.*每月一份/);
});
