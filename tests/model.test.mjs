import test from 'node:test';import assert from 'node:assert/strict';
import {validProfile,validMedia,inRange,postKey,fingerprint,mergePost,exportRevision,isOriginalPost} from '../extension/model.js';
test('profile URL restriction excludes feeds, post links, other origins',()=>{assert.ok(validProfile('https://weibo.com/u/1000000001'));assert.ok(validProfile('https://weibo.com/1000000001'));for(const u of ['https://evil.com/u/123','https://weibo.com/123/Rfoo','https://weibo.com/','http://weibo.com/u/123'])assert.equal(validProfile(u),false)});
test('media allowlist blocks credential URLs and suffix tricks',()=>{assert.ok(validMedia('https://wx4.sinaimg.cn/orj360/a.jpg'));for(const u of ['https://sinaimg.cn.evil.com/a','https://user:password@wx1.sinaimg.cn/a','javascript:foo','http://wx1.sinaimg.cn/a'])assert.equal(validMedia(u),false)});
test('date boundaries use Beijing and unknown date excluded only with filter',()=>{assert.ok(inRange({createdAt:'2026-10-31T16:00:00Z'},{from:'2026-11-01',to:'2026-11-01'}));assert.equal(inRange({createdAt:'2026-10-31T15:59:59Z'},{from:'2026-11-01'}),false);assert.ok(inRange({createdAt:null}));assert.equal(inRange({createdAt:null},{to:'2026-11-01'}),false)});
test('stable string IDs, duplicates, edits, and no complete-body downgrade',async()=>{const p={uid:'1000000001',id:'90071992547409930001',text:'第一版',images:[],repostText:'',fullText:true};assert.equal(postKey(p),'1000000001:90071992547409930001');const h=await fingerprint(p),a=await mergePost(null,p,'2026-01-01');const b=await mergePost(a,p,'2026-01-02');assert.equal(b.versions.length,0);const edited={...p,text:'第二版'},c=await mergePost(b,edited);assert.equal(c.versions.length,1);assert.equal(c.versions[0].text,'第一版');const d=await mergePost(c,{...p,text:'第二…',fullText:false});assert.equal(d.text,'第二版');assert.equal(d.contentHash,c.contentHash)});

test('metadata improvements are incremental, known absolute dates never downgrade',async()=>{const p={uid:'123456',id:'R12345',text:'body',images:[],fullText:true,createdAt:null,dateRaw:'11-01',dateApproximate:false};const unknown=await mergePost(null,p);const known=await mergePost(unknown,{...p,createdAt:'2026-11-01T01:00:00Z',dateRaw:'2026-11-01 09:00'});assert.notEqual(known.contentHash,unknown.contentHash);const again=await mergePost(known,p);assert.equal(again.createdAt,known.createdAt);assert.equal(again.contentHash,known.contentHash);const rounded=await mergePost(known,{...p,createdAt:'2026-11-01T02:00:00Z',dateRaw:'2小时前',dateApproximate:true});assert.equal(rounded.createdAt,known.createdAt);assert.equal(rounded.contentHash,known.contentHash);assert.ok(inRange(rounded,{from:'2026-11-01',to:'2026-11-01'}));const estimated=await mergePost(null,{...p,createdAt:'2026-11-01T02:00:00Z',dateRaw:'2小时前',dateApproximate:true});const exact=await mergePost(estimated,{...p,createdAt:'2026-11-01T01:01:00Z',dateRaw:'2026-11-01 09:01',dateApproximate:false});assert.notEqual(exact.contentHash,estimated.contentHash);assert.equal(exact.createdAt,'2026-11-01T01:01:00Z')});

test('incremental revision includes new versions even when content reverts A to B to A',async()=>{const a={uid:'123456',id:'R12345',text:'A',images:[],fullText:true};const first=await mergePost(null,a),exported=exportRevision(first,true);const edited=await mergePost(first,{...a,text:'B'});const reverted=await mergePost(edited,a);assert.equal(reverted.contentHash,first.contentHash);assert.notEqual(exportRevision(reverted,true),exported);assert.notEqual(exportRevision(first,false),exported)});

test('new emoticon sources update export revision and survive later collapsed observations',async()=>{
  const original={uid:'123456',id:'R12345',text:'完整内容[笑cry]',images:[],fullText:true};
  const before=await mergePost(null,original);
  const emoticons=[{text:'[笑cry]',url:'https://h5.sinaimg.cn/m/emoticon/laugh.png'}];
  const after=await mergePost(before,{...original,emoticons});
  assert.notEqual(after.contentHash,before.contentHash);
  assert.notEqual(exportRevision(after,true),exportRevision(before,true));
  const collapsed=await mergePost(after,{...original,text:'完整内…',fullText:false,emoticons:[]});
  assert.deepEqual(collapsed.emoticons,emoticons);
  assert.equal(collapsed.contentHash,after.contentHash);
});

test('original-only classification rejects quote evidence and known repost history',()=>{
  const own={isRepost:false,text:'我讨论了“转发”这个功能，也提到 //@某人',repostText:'',repostUrl:'',versions:[]};
  assert.equal(isOriginalPost(own),true);
  for(const evidence of [{isRepost:true},{repostText:'引用原文'},{repostUrl:'https://weibo.com/123/Rquote'},{unavailableRepost:true},{retweeted_status:{}},
    {versions:[{isRepost:true}]},{versions:[{versions:[{repostText:'较早引用原文'}]}]}])assert.equal(isOriginalPost({...own,...evidence}),false);
  assert.equal(isOriginalPost(null),false);
});

test('fresh adapter repairs only the legacy footer-icon false positive without deleting history',async()=>{
  const weak={uid:'123456',id:'R12345',text:'完整原创内容',images:[],fullText:true,isRepost:true,repostText:'',repostUrl:''};
  const old=await mergePost(null,weak);
  const current=await mergePost(old,{...weak,isRepost:false,repostDetectionVersion:2});
  assert.equal(current.isRepost,false);assert.equal(isOriginalPost(current),true);
  assert.equal(current.versions.length,1);assert.equal(current.versions[0].isRepost,true);
  const partial=await mergePost(old,{...weak,text:'完整原…',fullText:false,isRepost:false,repostDetectionVersion:2});
  assert.equal(partial.text,weak.text);assert.equal(partial.isRepost,false);assert.equal(isOriginalPost(partial),true);
  for(const evidence of [{repostText:'真实引用原文'},{repostUrl:'https://weibo.com/999999/Rquote'},{unavailableRepost:true},{repostDetectionVersion:2}]){
    const actual=await mergePost(null,{...weak,...evidence});
    const lost=await mergePost(actual,{...weak,isRepost:false,repostDetectionVersion:2});
    assert.equal(isOriginalPost(lost),false,'strong saved evidence survives a missing quote container');
  }
});
