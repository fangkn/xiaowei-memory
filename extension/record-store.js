import {postKey,mergePost} from './model.js';
/** Migrate legacy mobile decimal IDs using only API-supplied exact idstr. */
export async function savePostRecord(store,post,{onlyExisting=false}={}){
  const key=postKey(post),canonical=await store.get('posts',key);
  const aliasKey=typeof post.sourceId==='string'&&/^\d+$/.test(post.sourceId)&&post.sourceId!==post.id?`${post.uid}:${post.sourceId}`:null;
  const candidate=aliasKey?await store.get('posts',aliasKey):null;
  const alias=candidate&&!candidate.identitySource&&/^\d+$/.test(candidate.id)?candidate:null;
  // 被过滤的转发仍可纠正已保存记录，但不会新增首次遇到的转发。
  if(onlyExisting&&!canonical&&!alias)return null;
  let previous=canonical||alias;
  if(canonical&&alias){
    const unique=new Map();for(const v of [...(canonical.versions||[]),...(alias.versions||[]),alias]){const {versions:_,...snapshot}=v;if(snapshot.contentHash&&!unique.has(snapshot.contentHash))unique.set(snapshot.contentHash,snapshot)}
    previous={...canonical,versions:[...unique.values()],firstSeenAt:[canonical.firstSeenAt,alias.firstSeenAt].filter(Boolean).sort()[0]};
  }
  const merged=await mergePost(previous,post);
  await store.put('posts',merged);
  // Delete only after the canonical copy and all prior snapshots are durable.
  if(aliasKey&&alias)await store.remove('posts',aliasKey);
  return merged;
}
