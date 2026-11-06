import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMonthlyPdf,printableText,wrapPdfText,wrapPdfInlineText} from '../extension/monthly-pdf.js';
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
