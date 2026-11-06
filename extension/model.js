export const SCHEMA_VERSION = 1;
export function validProfile(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && ['weibo.com','www.weibo.com'].includes(u.hostname) && /^\/(?:u\/)?\d+\/?$/.test(u.pathname); } catch { return false; }
}
export function validMedia(url) {
  try { const u=new URL(url); return u.protocol==='https:' && (u.hostname==='sinaimg.cn' || u.hostname.endsWith('.sinaimg.cn')) && !u.port && !u.username && !u.password; } catch { return false; }
}
export function inRange(post, {from='',to=''}={}) {
  if (!from && !to) return true;
  if (!post.createdAt || !Number.isFinite(Date.parse(post.createdAt))) return false;
  const timestamp=Date.parse(post.createdAt);
  return (!from || timestamp>=Date.parse(`${from}T00:00:00+08:00`)) && (!to || timestamp<=Date.parse(`${to}T23:59:59.999+08:00`));
}
export function postKey(post) { return `${post.uid}:${post.id}`; }
const repostFlag = value => value === true || value === 1 || value === 'true';
function strongRepostEvidence(post) {
  return repostFlag(post.unavailableRepost) ||
    [post.repostText,post.repostUrl].some(value => typeof value === 'string' && value.trim()) ||
    post.retweeted_status != null ||
    (post.repostDetectionVersion >= 2 && repostFlag(post.isRepost));
}
/** Keep quoted posts out even when a later collapsed card loses its quote. */
export function isOriginalPost(post) {
  if (!post || typeof post !== 'object') return false;
  // Older adapters mistook the footer's retweet icon for a quote container.
  // A fresh v2 observation may correct only that unsupported legacy flag.
  const correctedLegacyFlag = post.repostDetectionVersion >= 2 && post.isRepost === false;
  const pending = [post], seen = new Set();
  while (pending.length) {
    const snapshot = pending.pop();
    if (!snapshot || typeof snapshot !== 'object' || seen.has(snapshot)) continue;
    seen.add(snapshot);
    if (strongRepostEvidence(snapshot) || (repostFlag(snapshot.isRepost) && !correctedLegacyFlag)) return false;
    if (Array.isArray(snapshot.versions)) pending.push(...snapshot.versions);
  }
  return true;
}
export async function fingerprint(post) {
  const bytes=new TextEncoder().encode(JSON.stringify([post.text,post.isRepost,post.repostText,post.repostUrl,post.images,post.fullText,post.author,post.url,post.createdAt,post.dateRaw,post.dateApproximate,post.emoticons||[]]));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function mergePost(existing,incoming,now=new Date().toISOString()) {
  const normalized={...incoming};
  const correctedLegacyFlag = incoming.repostDetectionVersion >= 2 && incoming.isRepost === false &&
    !strongRepostEvidence(incoming) && existing?.isRepost === true && !strongRepostEvidence(existing);
  const versions=[...(existing?.versions||[])];
  const keepVersion=snapshot=>{if(!versions.some(v=>v.contentHash===snapshot.contentHash))versions.push(snapshot)};
  // Preserve a reliable saved timestamp when the current card loses its tooltip
  // or shows a rounded relative label. Upgrade estimated dates when absolute.
  if(existing?.createdAt && (!incoming.createdAt || incoming.dateApproximate)) {
    normalized.createdAt=existing.createdAt;
    normalized.dateRaw=existing.dateRaw;
    normalized.dateApproximate=existing.dateApproximate;
  }
  // Virtualized cards often collapse again. Keep the best known body/media.
  if(existing?.fullText && (!incoming.fullText || (existing.isRepost&&!incoming.isRepost&&!correctedLegacyFlag))) {
    normalized.fullText=false;
    const observedHash=await fingerprint(normalized);
    if(observedHash!==existing.contentHash){const {versions:_,...observation}=normalized;keepVersion({...observation,key:postKey(normalized),contentHash:observedHash,firstSeenAt:now,lastSeenAt:now,observationOnly:true})}
    for(const k of ['text','isRepost','repostText','repostUrl','images','emoticons','fullText']){
      if(correctedLegacyFlag&&['isRepost','repostText','repostUrl'].includes(k))continue;
      normalized[k]=existing[k];
    }
  }
  if(existing?.author && (!incoming.author || incoming.author===incoming.uid))normalized.author=existing.author;
  const hash=await fingerprint(normalized);
  if(existing && existing.contentHash !== hash) {
    const {versions:_,...snapshot}=existing;keepVersion(snapshot);
  }
  return {...normalized,key:postKey(normalized),contentHash:hash,firstSeenAt:existing?.firstSeenAt||now,lastSeenAt:now,versions};
}

export function exportRevision(post,images=false){
  return JSON.stringify([post.contentHash,(post.versions||[]).map(v=>v.contentHash),images?'images':'text']);
}
