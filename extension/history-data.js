import {normalizeExportMediaURL} from './media-data.js';

/** Pure validation and normalization for the experimental Weibo history adapter.
 * Endpoint shapes are based on the user-provided Speechless source, not a public
 * API contract. Reject unknown/error shapes rather than treating them as EOF.
 */
export class HistoryDataError extends Error {
  constructor(code, message) { super(message); this.name='HistoryDataError'; this.code=code; }
}
const fail=(code,message)=>{throw new HistoryDataError(code,message)};
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const string=value=>typeof value==='string' ? value : '';
function uidString(value,label='账号 UID') {
  const id=typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
  if(!/^\d{4,20}$/.test(id))fail('INVALID_UID',`${label} 必须是 4–20 位数字字符串；不接受不安全数值`);
  return id;
}
function monthParts(value) {
  if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))fail('INVALID_MONTH','年月必须为 YYYY-MM');
  const [year,month]=value.split('-').map(Number);return {year,month};
}
export function createMonthPlan(uid,startMonth,endMonth,now=Date.now()) {
  uid=uidString(uid);const start=monthParts(startMonth),end=monthParts(endMonth);
  const time=new Date(now);if(!Number.isFinite(time.getTime()))fail('INVALID_NOW','当前时间无效');
  const current=new Date(time.getTime()+8*3600000).toISOString().slice(0,7);
  if(start.year<2009||end.year<2009||startMonth>endMonth||endMonth>current)fail('INVALID_RANGE','月份范围须从 2009 年起，开始不晚于结束，结束不晚于当前北京时间月份');
  const plan=[];
  for(let y=start.year,m=start.month;y<end.year||(y===end.year&&m<=end.month);){
    const key=`${y}-${String(m).padStart(2,'0')}`;
    const starttime=Math.floor((Date.UTC(y,m-1,1)-8*3600000)/1000);
    const endtime=Math.floor((Date.UTC(y,m,1)-8*3600000)/1000)-1;
    plan.push({key,uid,starttime,endtime,page:1});if(++m===13){m=1;y++}
  }
  return plan;
}
function checkEnvelope(json) {
  if(!object(json))fail('INVALID_JSON_SHAPE','响应不是 JSON 对象');
  const message=string(json.msg)||string(json.message)||string(json.errmsg)||string(json.error)||'';
  const code=String(json.error_code??json.errno??'');
  // Explicit restriction evidence wins even when a contradictory wrapper says ok=1.
  if(/登录|登陆|login|auth|未授权|过期/i.test(message)||['100001','100002'].includes(code))fail('AUTH_REQUIRED','微博要求重新登录或授权，已暂停；请在原页面处理');
  if(/频繁|频次|限流|rate.?limit|too many|验证码|安全验证|访问受限/i.test(message))fail('RESTRICTED','微博返回访问限制或验证提示，已暂停；请在原页面处理');
  if(json.ok!==1||(code&&code!=='0'))fail('API_ERROR','微博接口返回失败状态，已暂停；未保存服务端原始错误文本');
}
export function parseSearchResponse(json) {
  checkEnvelope(json);
  if(!object(json.data)||!Array.isArray(json.data.list))fail('INVALID_LIST','响应缺少 data.list 数组，不能当作空页');
  if(json.data.list.some(item=>!object(item)))fail('INVALID_POST','微博列表包含非对象项目');
  const total=Number.isSafeInteger(json.data.total)&&json.data.total>=0?json.data.total:null;
  // total is a hint only: never an authoritative count or completion condition.
  return {list:json.data.list,total};
}
export function parseLongTextResponse(json) {
  checkEnvelope(json);
  if(!object(json.data)||typeof json.data.longTextContent!=='string'||!json.data.longTextContent.trim())fail('INVALID_LONGTEXT','长文响应缺少非空 data.longTextContent');
  return json.data.longTextContent;
}
export function parseHistoryDirectory(json) {
  checkEnvelope(json);
  if(!object(json.data))fail('INVALID_DIRECTORY','年月目录缺少 data 对象');
  const result=[];
  for(const [year,months] of Object.entries(json.data)) {
    if(!/^\d{4}$/.test(year)||+year<2009||!Array.isArray(months))fail('INVALID_DIRECTORY','年月目录结构变化，不能可靠读取');
    for(const month of months) {
      if(!((typeof month==='number'&&Number.isInteger(month))||(typeof month==='string'&&/^\d{1,2}$/.test(month)))||+month<1||+month>12)fail('INVALID_DIRECTORY','年月目录包含无效月份');
      result.push(`${year}-${String(+month).padStart(2,'0')}`);
    }
  }
  return [...new Set(result)].sort();
}
function stableId(raw) {
  // The DOM adapter keys by base62 permalink ID. Requiring mblogid avoids
  // silently splitting the same post into decimal-id and base62-id records.
  if(typeof raw.mblogid==='string'&&/^[A-Za-z0-9]{1,128}$/.test(raw.mblogid))return {id:raw.mblogid,source:'mblogid'};
  fail('INVALID_POST_ID','缺少可靠 mblogid 字符串；不把数值 ID 猜测成永久链接 ID');
}
function authorUid(raw) {
  if(!object(raw.user))fail('MISSING_AUTHOR','微博缺少作者信息，不能确认账号归属');
  return uidString(raw.user.idstr??raw.user.id,'微博作者 UID');
}
function mediaURL(value) {
  return normalizeExportMediaURL(value);
}
function imagesOf(raw) {
  const found=[];
  if(object(raw.pic_infos))for(const item of Object.values(raw.pic_infos)) {
    if(!object(item))continue;
    const url=mediaURL(item.large?.url||item.original?.url||item.url);if(url)found.push(url);
  }
  if(Array.isArray(raw.pics))for(const item of raw.pics) {
    const url=mediaURL(item?.large?.url||item?.url);if(url)found.push(url);
  }
  return [...new Set(found)];
}
function apiDate(raw) {
  if(typeof raw!=='string'||!raw.trim())return null;
  // Never let Date.parse invent a local timezone from a timezone-less value.
  if(!/(?:Z|[+-]\d{2}:?\d{2})\s*(?:\d{4})?$/i.test(raw.trim()))return null;
  const iso=raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if(iso){const [,y,m,d,h,min,sec]=iso.map(Number);if(m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||h>23||min>59||sec>59)return null;}
  const rfc=raw.match(/^[A-Za-z]{3} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) [+-]\d{4} (\d{4})$/);
  if(rfc){const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(rfc[1])+1;const [, ,d,h,min,sec,y]=rfc;if(+d<1||+d>new Date(Date.UTC(+y,m,0)).getUTCDate()||+h>23||+min>59||+sec>59)return null}
  const value=Date.parse(raw);return Number.isFinite(value)?new Date(value).toISOString():null;
}
function textContent(raw,toText,toEmoticons) {
  if(!['text','text_raw','longTextContent'].some(k=>typeof raw[k]==='string'))fail('MISSING_TEXT','微博缺少正文文本字段，不能静默导出空正文');
  // text_raw is the same plain-text excerpt, not proof of full long-text retrieval.
  const full=typeof raw.longTextContent==='string'&&raw.longTextContent.trim()?raw.longTextContent:null;
  for(const flag of ['isLongText','is_long_text'])if(raw[flag]!==undefined&&![true,false,0,1].includes(raw[flag]))fail('INVALID_LONGTEXT_FLAG','长文标记格式变化，不能确认正文完整性');
  const html=full??(typeof raw.text==='string'?raw.text:typeof raw.text_raw==='string'?raw.text_raw:'');
  const result=full!==null||typeof raw.text==='string'?toText(html):html;
  if(typeof result!=='string')fail('INVALID_TEXT_ADAPTER','正文转换器必须返回字符串');
  const marker=/(?:展开全文|全文<\/a>|class=["'][^"']*\bexpand\b)/.test(html);
  const required=!full&&(raw.isLongText===true||raw.isLongText===1||raw.is_long_text===true||raw.is_long_text===1||marker);
  const emoticons = typeof toEmoticons === 'function' && (full !== null || typeof raw.text === 'string') ? toEmoticons(html) : [];
  if (!Array.isArray(emoticons)) fail('INVALID_TEXT_ADAPTER','表情转换器必须返回数组');
  return {text:result,required,emoticons:emoticons.filter(item => typeof item?.text === 'string' && item.text.length > 0 && item.text.length <= 80 && result.includes(item.text) && mediaURL(item.url)).map(item => ({text:item.text,url:mediaURL(item.url)}))};
}
export function normalizeApiPost(raw,uid,toText,toEmoticons) {
  if(!object(raw))fail('INVALID_POST','微博必须是对象');
  uid=uidString(uid);if(typeof toText!=='function')fail('INVALID_TEXT_ADAPTER','缺少安全正文转换器');
  const ownUid=authorUid(raw);if(ownUid!==uid)fail('AUTHOR_MISMATCH',`返回微博作者 ${ownUid} 与目标账号 ${uid} 不一致`);
  const ownId=stableId(raw),own=textContent(raw,toText,toEmoticons),needsLongText=[];
  if(own.required)needsLongText.push({id:ownId.id,kind:'own'});
  let repostText='',repostUrl='',isRepost=raw.retweeted_status!==undefined&&raw.retweeted_status!==null;
  let repostImages=[],quotedIncomplete=false;
  if(isRepost) {
    if(!object(raw.retweeted_status))fail('INVALID_REPOST','转发字段格式异常');
    const quoted=raw.retweeted_status;
    // Deleted/unavailable quoted posts can legitimately lack a user/id. Keep the
    // visible explanation but do not report their full text as established.
    const unavailableBody=!object(quoted.user)&&!['text','text_raw','longTextContent'].some(k=>typeof quoted[k]==='string');
    const body=unavailableBody?{text:'被转发原文不可访问，页面接口未提供正文。',required:false}:textContent(quoted,toText);repostText=body.text;repostImages=imagesOf(quoted);
    if(object(quoted.user)) {
      const quoteUid=authorUid(quoted),quoteId=stableId(quoted);
      repostUrl=quoteId.source==='mblogid'||quoteId.source==='bid'?`https://weibo.com/${quoteUid}/${quoteId.id}`:`https://m.weibo.cn/detail/${quoteId.id}`;
      if(body.required)needsLongText.push({id:quoteId.id,kind:'repost'});
      quotedIncomplete=body.required;
    } else { quotedIncomplete=true; }
  }
  const dateRaw=string(raw.created_at);
  return {id:ownId.id,identitySource:ownId.source,sourceId:typeof raw.idstr==='string'&&/^\d{1,32}$/.test(raw.idstr)?raw.idstr:'',uid,author:string(raw.user.screen_name)||uid,
    url:ownId.source==='mblogid'||ownId.source==='bid'?`https://weibo.com/${uid}/${ownId.id}`:`https://m.weibo.cn/detail/${ownId.id}`,
    createdAt:apiDate(dateRaw),dateRaw,dateApproximate:false,text:own.text,
    images:[...new Set([...imagesOf(raw),...repostImages])],emoticons:own.emoticons,isRepost,repostDetectionVersion:2,repostText,repostUrl,
    fullText:!own.required&&!quotedIncomplete,needsLongText,
    unavailableRepost:isRepost&&quotedIncomplete&&!needsLongText.some(x=>x.kind==='repost')};
}

// Naming alias for the collection state machine.
export const parseDirectoryResponse=parseHistoryDirectory;
