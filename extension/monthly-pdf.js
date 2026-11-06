import {PDFDocument,PDFString,PDFName,PDFHexString,PDFOperator,rgb} from './vendor/pdf-lib.esm.min.js';
import fontkit from './vendor/fontkit.esm.min.js';
import {dateParts} from './dates.js';
import {isOriginalPost} from './model.js';

const PAGE=[595.28,841.89], MARGIN=48, BOTTOM=57, WIDTH=PAGE[0]-MARGIN*2;
const INK=rgb(52/255,57/255,70/255), MUTED=rgb(98/255,108/255,125/255), ACCENT=rgb(109/255,91/255,208/255), RULE=rgb(228/255,230/255,236/255);
const MAX_POSTS=10000, MAX_CHARACTERS=3000000, MAX_PAGES=2000, MAX_BYTES=96*1024*1024;
const MAX_IMAGE_PIXELS=40000000, SMALL_PNG_PIXELS=256*256, IMAGE_LONG_EDGE=2400;
let bundledFont;

async function loadFont(){
  if(!bundledFont)bundledFont=fetch(new URL('./fonts/NotoSansSC-Regular.ttf',import.meta.url)).then(async response=>{
    if(!response.ok)throw new Error('无法读取本地中文字体，请重新加载扩展。');
    return new Uint8Array(await response.arrayBuffer());
  }).catch(error=>{bundledFont=null;throw error});
  return bundledFont;
}

const graphemeSegmenter=new Intl.Segmenter('zh',{granularity:'grapheme'});
const graphemes=value=>[...graphemeSegmenter.segment(value)].map(part=>part.segment);
const invisibleFormatting=/[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const emojiGrapheme=value=>/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value);
const normalizeText=value=>String(value??'').replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(invisibleFormatting,'');

/** 过滤无视觉内容的格式字符；保留无法显示的正文编码和可绘制的完整表情簇。 */
export function printableText(value,supported,missing=new Set(),inlineImages=new Map()){
  let result='';
  for(const cluster of graphemes(normalizeText(value))){
    if(inlineImages.has(cluster)){result+=cluster;continue}
    for(const char of cluster){
      const code=char.codePointAt(0);
      if(char==='\n'){result+='\n';continue}
      if(code<32||code===127||/[\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(char))continue;
      if(supported.has(code))result+=char;
      else {missing.add(code);result+=`[U+${code.toString(16).toUpperCase().padStart(4,'0')}]`}
    }
  }
  return result;
}

function canvasFor(width,height){
  if(typeof OffscreenCanvas==='function')return new OffscreenCanvas(width,height);
  if(typeof document!=='undefined')return Object.assign(document.createElement('canvas'),{width,height});
  throw new Error('当前环境无法绘制表情');
}

async function canvasPng(canvas){
  const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/png'}):await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('表情绘制失败')),'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** 使用系统彩色表情字体在本地绘制，不请求远程字体或表情服务。 */
export async function renderEmojiPng(cluster){
  const canvas=canvasFor(128,128),context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)throw new Error('无法创建表情画布');
  const family='"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  context.font=`96px ${family}`;
  const width=context.measureText(cluster).width;
  if(width>112)context.font=`${Math.floor(96*112/width)}px ${family}`;
  context.textAlign='center';context.textBaseline='middle';context.fillStyle='#000';
  context.fillText(cluster,64,64);
  const pixels=context.getImageData(0,0,128,128).data;
  let left=128,top=128,right=-1,bottom=-1;
  for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(pixels[(y*128+x)*4+3]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
  if(right<left||bottom<top)throw new Error('系统未能绘制这个表情');
  const cropped=canvasFor(right-left+5,bottom-top+5),target=cropped.getContext('2d');
  target.drawImage(canvas,left,top,right-left+1,bottom-top+1,2,2,right-left+1,bottom-top+1);
  return canvasPng(cropped);
}

const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** 将可搜索文字与彩色表情一起折行，表情作为完整簇而非逐码点拆分。 */
export function wrapPdfInlineText(text,font,size,maxWidth=WIDTH,inlineImages=new Map()){
  if(!(maxWidth>0))throw new Error('PDF 文本宽度无效');
  const pattern=inlineImages.size?new RegExp([...inlineImages.keys()].sort((a,b)=>b.length-a.length).map(escapePattern).join('|'),'gu'):null;
  const tokens=[];
  const plain=value=>{for(const token of value.match(/[A-Za-z0-9_]+(?:[.'’\-][A-Za-z0-9_]+)*|[^\n]/gu)||[])tokens.push({text:token,width:font.widthOfTextAtSize(token,size)})};
  let offset=0;
  if(pattern)for(const match of text.matchAll(pattern)){plain(text.slice(offset,match.index));tokens.push({emoji:match[0],image:inlineImages.get(match[0]),width:size*1.12});offset=match.index+match[0].length}
  plain(text.slice(offset));
  const lines=[];let line=[],width=0;
  const finish=()=>{while(line.length&&line.at(-1).text&&/^\s+$/.test(line.at(-1).text))line.pop();lines.push(line);line=[];width=0};
  const add=token=>{
    if(token.text&&token.width>maxWidth&&graphemes(token.text).length>1){for(const char of graphemes(token.text))add({text:char,width:font.widthOfTextAtSize(char,size)});return}
    if(line.length&&width+token.width>maxWidth)finish();
    if(!line.length&&token.text&&/^\s+$/.test(token.text))return;
    line.push(token);width+=token.width;
  };
  for(const token of tokens)add(token);
  finish();return lines;
}

/** 按字体实际宽度折行，长 URL 和连续英文也不会超出页面。 */
export function wrapPdfText(text,font,size,maxWidth=WIDTH){
  if(!(maxWidth>0))throw new Error('PDF 文本宽度无效');
  const lines=[],widthCache=new Map();
  const measure=value=>{if(!widthCache.has(value))widthCache.set(value,font.widthOfTextAtSize(value,size));return widthCache.get(value)};
  for(const paragraph of String(text).split('\n')){
    if(!paragraph){lines.push('');continue}
    const tokens=paragraph.match(/[A-Za-z0-9_]+(?:[.'’\-][A-Za-z0-9_]+)*|[^\n]/gu)||[];
    let line='',width=0;
    const add=token=>{
      const tokenWidth=measure(token);
      if(tokenWidth>maxWidth&&Array.from(token).length>1){for(const char of token)add(char);return}
      if(line&&width+tokenWidth>maxWidth){lines.push(line.trimEnd());line='';width=0}
      if(!line&&/^\s+$/.test(token))return;
      line+=token;width+=tokenWidth;
    };
    for(const token of tokens)add(token);
    lines.push(line.trimEnd());
  }
  return lines;
}

function sourceUrl(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||!['weibo.com','www.weibo.com'].includes(url.hostname)||url.username||url.password)return null;url.search='';url.hash='';return url.href}catch{return null}
}

/** 大 PNG 和动画第一帧转为有界 JPEG，避免 PDF 长期持有每张图的解码 RGB。 */
async function convertImage(item){
  if(typeof createImageBitmap!=='function')throw new Error('当前环境无法转换该图片格式');
  const bitmap=await createImageBitmap(new Blob([item.bytes],{type:item.mime}));
  let canvas;
  try{
    if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>MAX_IMAGE_PIXELS)throw new Error('图片尺寸过大');
    const scale=Math.min(1,IMAGE_LONG_EDGE/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
    canvas=canvasFor(width,height);
    const context=canvas.getContext('2d');
    if(!context)throw new Error('无法创建图片画布');
    context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/jpeg',quality:.9}):await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图片转换失败')),'image/jpeg',.9));
    return {bytes:new Uint8Array(await blob.arrayBuffer()),mime:'image/jpeg'};
  }finally{bitmap.close();if(canvas){canvas.width=1;canvas.height=1}}
}

function pngDimensions(bytes){
  if(bytes.length<24||bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71)throw new Error('PNG 数据无效');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return {width:view.getUint32(16),height:view.getUint32(20)};
}

async function embedImage(pdf,item){
  if(!(item?.bytes instanceof Uint8Array)||!item.bytes.length||item.bytes.length>12*1024*1024)throw new Error('图片内容无效或过大');
  const mime=String(item.mime||'').split(';')[0].toLowerCase().trim();
  if(!['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(mime))throw new Error('不支持的图片格式');
  let keepPng=false;
  if(mime==='image/png'){
    const dimensions=pngDimensions(item.bytes);
    if(!dimensions.width||!dimensions.height||dimensions.width*dimensions.height>MAX_IMAGE_PIXELS)throw new Error('图片尺寸过大');
    // 表情等小 PNG 保留透明；照片先转 JPEG，PDF 内只保留压缩流。
    keepPng=dimensions.width*dimensions.height<=SMALL_PNG_PIXELS;
  }
  const data=mime==='image/jpeg'||keepPng?{...item,mime}:await convertImage({...item,mime});
  const image=data.mime==='image/png'?await pdf.embedPng(data.bytes):await pdf.embedJpg(data.bytes);
  if(!image.width||!image.height||image.width*image.height>MAX_IMAGE_PIXELS)throw new Error('图片尺寸过大');
  return image;
}

/** 在浏览器本地生成一个月的原创 PDF；字体与表情绘制器可供离线测试注入。 */
export async function buildMonthlyPdf(batch,{media=new Map(),images=false,onProgress=()=>{},fontBytes=null,emojiRenderer=renderEmojiPng}={}){
  if(!/^\d+$/.test(String(batch?.uid||''))||!(/^(?:\d{4}-(?:0[1-9]|1[0-2])|unknown)$/.test(batch?.month||'')))throw new Error('PDF 账号或月份无效');
  if(!Array.isArray(batch.posts)||!batch.posts.length)throw new Error('这个月没有可导出的原创微博');
  if(batch.posts.length>MAX_POSTS)throw new Error('该月超过 10000 条，请先缩小本地数据范围后重试');
  for(const post of batch.posts){
    if(String(post.uid)!==String(batch.uid)||!isOriginalPost(post))throw new Error('PDF 只能包含目标账号的原创微博');
    if((dateParts(post.createdAt)?.month||'unknown')!==batch.month)throw new Error('PDF 月份与微博日期不一致');
  }
  if(batch.posts.reduce((sum,post)=>sum+String(post.text||'').length+String(post.author||'').length,0)>MAX_CHARACTERS)throw new Error('该月正文超过 300 万字符，无法一次生成 PDF');
  const posts=[...batch.posts].sort((a,b)=>(dateParts(a.createdAt)?.time||0)-(dateParts(b.createdAt)?.time||0)||String(a.id).localeCompare(String(b.id)));
  onProgress({stage:'font',completed:0,total:posts.length});
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
  const bytes=fontBytes||await loadFont();
  const supported=new Set(fontkit.create(bytes).characterSet),missingGlyphs=new Set();
  const unicodeEmojiImages=new Map(),unicodeEmojiFailures=new Set(),embeddedImages=new Map(),failedMediaUrls=new Set(),attachmentFailures=[];
  const attachmentFailure=(post,url,kind,reason)=>attachmentFailures.push({postId:String(post.id||''),postUrl:String(post.url||''),url:typeof url==='string'?url:String(url??''),kind,reason});
  let savedEmojiCount=0,failedUnicodeEmojiCount=0,failedEmoticonCount=0;
  const visibleTexts=posts.flatMap(post=>[post.text||'',post.author||'',post.dateRaw||'']);
  const unicodeEmoji=new Set(visibleTexts.flatMap(value=>graphemes(normalizeText(value)).filter(emojiGrapheme)));
  for(const cluster of unicodeEmoji){
    try{unicodeEmojiImages.set(cluster,await embedImage(pdf,{bytes:await emojiRenderer(cluster),mime:'image/png'}))}
    catch{unicodeEmojiFailures.add(cluster)}
  }
  for(const value of visibleTexts)for(const cluster of graphemes(normalizeText(value))){if(unicodeEmojiImages.has(cluster))savedEmojiCount++;else if(unicodeEmojiFailures.has(cluster))failedUnicodeEmojiCount++}
  const clean=value=>printableText(value,supported,missingGlyphs,unicodeEmojiImages);
  // fontkit 对此中文字体做子集会遗漏字形；完整嵌入保证不同 PDF 阅读器显示一致。
  const font=await pdf.embedFont(bytes,{subset:false});
  const monthLabel=batch.month==='unknown'?'未知日期':`${batch.month.slice(0,4)} 年 ${Number(batch.month.slice(5))} 月`;
  const author=clean(posts.find(post=>post.author)?.author||`UID ${batch.uid}`);
  const title=`${monthLabel} · 原创微博`;
  pdf.setTitle(`${title} - ${author}`);pdf.setAuthor(author);pdf.setSubject(`UID ${batch.uid} 的本机原创微博月度备份`);pdf.setCreator('小微记忆');pdf.setProducer('pdf-lib / 小微记忆');pdf.setLanguage('zh-CN');
  // 提前处理全部可见文本，使首页的缺字提示准确。
  const prepared=[];
  for(const post of posts){
    const inlineImages=new Map(unicodeEmojiImages);let failedEmoticons=0;
    for(const cluster of new Set([post.text||'',post.author||'',post.dateRaw||''].flatMap(value=>graphemes(normalizeText(value))))){
      if(unicodeEmojiFailures.has(cluster))attachmentFailure(post,'','unicode',`系统未能绘制表情 ${cluster}，已保留文字编码。`);
    }
    if(images){
      const candidates=new Map();
      for(const item of Array.isArray(post.emoticons)?post.emoticons:[]){
        if(typeof item?.text!=='string'||!item.text||item.text.length>80||typeof item.url!=='string'||inlineImages.has(item.text))continue;
        if(!candidates.has(item.text))candidates.set(item.text,new Set());
        candidates.get(item.text).add(item.url);
      }
      for(const [text,urls] of candidates){
        const count=String(post.text||'').split(text).length-1;if(!count)continue;
        for(const url of urls)try{
          if(!embeddedImages.has(url))embeddedImages.set(url,await embedImage(pdf,media.get(url)));
          inlineImages.set(text,embeddedImages.get(url));break;
        }catch{failedMediaUrls.add(url);/* 同一表情可能有新旧地址，尝试其余已准备的素材。 */}
        if(inlineImages.has(text))savedEmojiCount+=count;
        else{
          failedEmoticons+=count;failedEmoticonCount+=count;
          for(const url of urls)attachmentFailure(post,url,'emoticon',`表情 ${text} 未能解码或嵌入 PDF，已保留文字标签。`);
        }
      }
    }
    prepared.push({...post,body:clean(post.text||'（无文字内容）'),inlineImages,failedEmoticons,authorLabel:clean(post.author||author),dateLabel:clean(dateParts(post.createdAt)?.display||`日期未知${post.dateRaw?` · ${post.dateRaw}`:''}`)});
  }
  let page,y,savedImageCount=0,failedImageCount=0;
  const pages=[];
  function addPage(){
    if(pages.length>=MAX_PAGES)throw new Error('该月 PDF 超过 2000 页，已停止生成');
    page=pdf.addPage(PAGE);pages.push(page);y=PAGE[1]-MARGIN;
    if(pages.length>1){page.drawText(clean(`${monthLabel} · 原创微博 · UID ${batch.uid}`),{x:MARGIN,y:y-8,size:9,font,color:MUTED});page.drawLine({start:{x:MARGIN,y:y-20},end:{x:PAGE[0]-MARGIN,y:y-20},thickness:.5,color:RULE});y-=43}
  }
  function room(height){if(y-height<BOTTOM)addPage()}
  function line(text,size=11.5,color=INK,leading=19){room(leading);if(text)page.drawText(text,{x:MARGIN,y:y-size,size,font,color});y-=leading}
  function paragraph(text,{size=11.5,color=INK,leading=19,gap=7,inlineImages=unicodeEmojiImages}={}){
    for(const block of String(text).split('\n')){
      const lines=wrapPdfInlineText(block,font,size,WIDTH,inlineImages);
      // 短段落整段换页，长段落至少保留两行，避免页首只剩孤立的一两个字。
      room(Math.min(lines.length,lines.length<=4?4:2)*leading);
      for(const [index,value] of lines.entries()){
        if(lines.length-index===2)room(2*leading);
        room(leading);let x=MARGIN,plain='',plainWidth=0;
        const flush=()=>{if(plain)page.drawText(plain,{x:x-plainWidth,y:y-size,size,font,color});plain='';plainWidth=0};
        for(const token of value){
          if(token.image){
            flush();
            // ActualText 保留表情语义，复制正文时不只得到一张无文字图片。
            page.pushOperators(PDFOperator.of('BDC',[PDFName.of('Span'),pdf.context.obj({ActualText:PDFHexString.fromText(token.emoji)})]));
            const scale=token.width/Math.max(token.image.width,token.image.height),width=token.image.width*scale,height=token.image.height*scale;
            page.drawImage(token.image,{x:x+(token.width-width)/2,y:y-size-1.5+(token.width-height)/2,width,height});
            page.pushOperators(PDFOperator.of('EMC',[]));
          }else{plain+=token.text;plainWidth+=token.width}
          x+=token.width;
        }
        flush();y-=leading;
      }
    }
    y-=gap;
  }
  function link(url){
    const safe=sourceUrl(url);if(!safe)return;
    for(const text of wrapPdfText(clean(safe),font,8.5)){
      room(14);const baseline=y-8.5;
      page.drawText(text,{x:MARGIN,y:baseline,size:8.5,font,color:MUTED});
      const annotation=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[MARGIN,baseline-2,MARGIN+font.widthOfTextAtSize(text,8.5),baseline+10],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of(safe)}}));
      page.node.addAnnot(annotation);y-=14;
    }
    y-=8;
  }
  addPage();
  page.drawRectangle({x:MARGIN,y:y-4,width:24,height:3,color:ACCENT});y-=24;
  paragraph(clean(title),{size:26,leading:36,gap:9});
  paragraph(author,{size:13,leading:20,gap:3});
  paragraph(`UID ${batch.uid}  /  ${posts.length} 条原创`,{size:9.5,color:MUTED,leading:16,gap:3});
  paragraph('按发布时间整理 · 仅包含本机已保存的原创内容',{size:9,color:MUTED,leading:15,gap:5});
  if(missingGlyphs.size)paragraph('部分表情或生僻字用 [U+编码] 保留，可通过原文链接查看。',{size:8.5,color:MUTED,leading:14,gap:4});
  page.drawLine({start:{x:MARGIN,y},end:{x:PAGE[0]-MARGIN,y},thickness:.7,color:RULE});y-=23;
  for(const [index,post] of prepared.entries()){
    room(95);
    paragraph(`${String(index+1).padStart(2,'0')}  /  ${post.dateLabel}`,{size:10,color:ACCENT,leading:17,gap:2});
    if(post.dateApproximate)paragraph('发布时间为页面估计值',{size:8,color:MUTED,leading:13,gap:2});
    if(post.authorLabel!==author)paragraph(post.authorLabel,{size:9,color:MUTED,leading:15,gap:3});
    paragraph(post.body,{inlineImages:post.inlineImages});
    if(post.failedEmoticons)paragraph(`有 ${post.failedEmoticons} 个表情未能嵌入，已保留文字标签。`,{size:8.5,color:MUTED,leading:14,gap:3});
    if(!post.fullText)paragraph('提示：此条正文可能未完整展开。',{size:8.5,color:MUTED,leading:14,gap:3});
    link(post.url);
    if(!images&&Array.isArray(post.images)&&post.images.length)paragraph(`本次仅导出文字，未包含 ${new Set(post.images).size} 张图片。`,{size:8.5,color:MUTED,leading:14,gap:4});
    if(images){
      const urls=[...new Set(Array.isArray(post.images)?post.images:[])];
      for(const [imageIndex,url] of urls.entries()){
        onProgress({stage:'image',completed:index,total:posts.length,imageIndex:imageIndex+1,imageTotal:urls.length});
        try{
          let image=embeddedImages.get(url);
          if(!image){image=await embedImage(pdf,media.get(url));embeddedImages.set(url,image)}
          const scale=Math.min(WIDTH/image.width,380/image.height,1),width=image.width*scale,height=image.height*scale;
          room(height+30);page.drawImage(image,{x:MARGIN+(WIDTH-width)/2,y:y-height,width,height});y-=height+7;
          line(`图片 ${imageIndex+1} / ${urls.length}`,8,MUTED,15);y-=6;savedImageCount++;
        }catch{
          failedMediaUrls.add(url);
          failedImageCount++;
          attachmentFailure(post,url,'image','图片未能解码或嵌入 PDF。');
          paragraph(`图片 ${imageIndex+1} 未能嵌入，请打开微博原文查看。`,{size:9,color:MUTED,leading:15,gap:4});
        }
      }
    }
    if(index<prepared.length-1){
      if(y-118<BOTTOM)addPage();
      else{page.drawLine({start:{x:MARGIN,y:y-4},end:{x:PAGE[0]-MARGIN,y:y-4},thickness:.5,color:RULE});y-=23}
    }
    onProgress({stage:'post',completed:index+1,total:posts.length});
    // 长月份在条目之间交还主线程，避免悬浮窗失去响应。
    if(index%10===9)await new Promise(resolve=>setTimeout(resolve,0));
  }
  for(const [index,item] of pages.entries()){
    item.drawLine({start:{x:MARGIN,y:42},end:{x:PAGE[0]-MARGIN,y:42},thickness:.5,color:RULE});
    item.drawText('仅原创 · 时间为北京时间',{x:MARGIN,y:27,size:8,font,color:MUTED});
    const counter=`${index+1} / ${pages.length}`;
    item.drawText(counter,{x:PAGE[0]-MARGIN-font.widthOfTextAtSize(counter,8),y:27,size:8,font,color:MUTED});
  }
  onProgress({stage:'save',completed:posts.length,total:posts.length});
  const output=await pdf.save();
  if(output.length>MAX_BYTES)throw new Error('该月 PDF 超过 96 MiB，请关闭图片后重新导出');
  return {bytes:output,failedImageCount:failedImageCount+failedEmoticonCount,savedImageCount,savedEmojiCount,failedEmojiCount:failedUnicodeEmojiCount+failedEmoticonCount,failedUnicodeEmojiCount,failedMediaUrls:[...failedMediaUrls],attachmentFailures,pageCount:pages.length,postCount:posts.length,missingGlyphs:[...missingGlyphs].map(code=>`U+${code.toString(16).toUpperCase().padStart(4,'0')}`)};
}
