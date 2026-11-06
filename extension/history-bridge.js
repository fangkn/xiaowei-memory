import {normalizeExportMediaURL} from './media-data.js';

/** Serialized into the active Weibo tab. No closure, arbitrary URL, headers or token access. */
export async function pageReadOnlyRequest(kind,params){
  const fail=(code,message)=>({ok:false,error:{code,message}});
  if(location.origin!=='https://weibo.com')return fail('ORIGIN','实验接口只支持 https://weibo.com 的数字 UID 主页');
  const pageUid=location.pathname.match(/^\/(?:u\/)?(\d{4,20})\/?$/)?.[1];
  if(!params||typeof params.uid!=='string'||!/^\d{4,20}$/.test(params.uid)||params.uid!==pageUid)return fail('UID','当前标签页账号与确认的 UID 不一致');
  const url=new URL(location.origin);url.search='';
  if(kind==='search'){
    if(!Number.isInteger(params.page)||params.page<1||params.page>1000||!Number.isSafeInteger(params.starttime)||!Number.isSafeInteger(params.endtime)||params.starttime<1230739200||params.endtime<params.starttime||params.endtime-params.starttime>32*86400)return fail('PARAMS','历史查询参数无效');
    url.pathname='/ajax/statuses/searchProfile';url.search=new URLSearchParams({uid:params.uid,page:String(params.page),feature:'4',starttime:String(params.starttime),endtime:String(params.endtime)});
  }else if(kind==='longtext'){
    if(typeof params.id!=='string'||!/^[A-Za-z0-9]{5,32}$/.test(params.id))return fail('PARAMS','长文 ID 无效');
    url.pathname='/ajax/statuses/longtext';url.search=new URLSearchParams({id:params.id});
  }else if(kind==='directory'){
    url.pathname='/ajax/profile/mbloghistory';url.search=new URLSearchParams({uid:params.uid});
  }else return fail('KIND','不支持的读取类型');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
    const response=await fetch(url.href,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
    if(!response.ok)return fail(response.status===429?'RATE_LIMIT':response.status===401||response.status===403?'AUTH_OR_RESTRICTED':'HTTP',`微博返回 HTTP ${response.status}`);
    if(!(response.headers.get('content-type')||'').toLowerCase().includes('json'))return fail('NOT_JSON','微博没有返回 JSON，可能需要登录或验证');
    if(Number(response.headers.get('content-length')||0)>4*1024*1024)return fail('TOO_LARGE','接口返回超过 4 MiB');
    const reader=response.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024){await reader.cancel();return fail('TOO_LARGE','接口返回超过 4 MiB')}chunks.push(value)}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}
    let json;try{json=JSON.parse(new TextDecoder().decode(bytes))}catch{return fail('INVALID_JSON','接口响应不是有效 JSON')}
    return {ok:true,json};
  }catch(error){return fail(error.name==='AbortError'?'TIMEOUT':'NETWORK',error.name==='AbortError'?'请求超时，当前页未跳过':'网络请求失败，当前页未跳过')}
  finally{clearTimeout(timer)}
}
export async function requestFromTab(tabId,kind,params){
  const results=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:pageReadOnlyRequest,args:[kind,params]});
  const result=results?.[0]?.result;if(!result?.ok)throw Object.assign(new Error(result?.error?.message||'页面读取结果缺失'),{code:result?.error?.code||'BRIDGE'});return result.json;
}
export function visibleLinkTarget(href,label=''){
  try{const url=new URL(href,'https://weibo.com/');if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return '';return String(label).includes(url.href)?'':url.href}catch{return ''}
}
export function htmlToText(html){
  if(typeof html!=='string'||html.length>4*1024*1024)throw new Error('正文长度超出安全上限');
  const template=document.createElement('template');template.innerHTML=html;const doc=template.content;
  doc.querySelectorAll('script,style,iframe,object,embed,svg').forEach(n=>n.remove());
  doc.querySelectorAll('a[href]').forEach(n=>{const target=visibleLinkTarget(n.getAttribute('href'),n.textContent);if(target)n.append(` (${target})`)});
  doc.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));doc.querySelectorAll('p,div').forEach(n=>n.append('\n'));
  doc.querySelectorAll('img').forEach(n=>n.replaceWith(n.getAttribute('alt')||''));
  return (doc.textContent||'').replace(/\r\n?/g,'\n').replace(/[\t ]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

export function htmlToEmoticons(html) {
  if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) throw new Error('正文长度超出安全上限');
  const template = document.createElement('template');
  template.innerHTML = html;
  const found = [], seen = new Set();
  for (const img of template.content.querySelectorAll('img')) {
    if (img.closest('script,style,iframe,object,embed,svg,[aria-hidden="true"]')) continue;
    const text = (img.getAttribute('alt') || '').trim();
    const url = normalizeExportMediaURL(img.getAttribute('data-src') || img.getAttribute('src') || '');
    if (!text || text.length > 80 || !url) continue;
    if (!/^\[[^\]\r\n]+\]$/.test(text) && !/emoji|emoticon|face/i.test(`${img.className || ''} ${url}`)) continue;
    const key = `${text}\n${url}`;
    if (!seen.has(key)) { seen.add(key); found.push({text, url}); }
  }
  return found;
}
