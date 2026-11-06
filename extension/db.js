let promise;
function open() {
  return promise ||= new Promise((resolve,reject)=>{
    const req=indexedDB.open('weibo-obsidian-local',1);
    req.onupgradeneeded=()=>{const db=req.result; db.createObjectStore('posts',{keyPath:'key'});db.createObjectStore('settings');db.createObjectStore('media',{keyPath:'url'});};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
async function request(store,mode,fn) {
  const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),r=fn(tx.objectStore(store));let result;r.onsuccess=()=>{result=r.result};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||r.error);tx.onabort=()=>reject(tx.error||new Error('数据库事务中止'));});
}
export const get=(s,k)=>request(s,'readonly',o=>o.get(k));
export const all=s=>request(s,'readonly',o=>o.getAll());
export const put=(s,v,k)=>request(s,'readwrite',o=>k===undefined?o.put(v):o.put(v,k));
export const remove=(s,k)=>request(s,'readwrite',o=>o.delete(k));
