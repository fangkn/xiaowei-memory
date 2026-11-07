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

/** 仅为仍然匹配的账号更新头像，避免其他浮窗切换账号后被迟到结果覆盖。 */
export async function saveTargetAvatar(uid, avatar) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('settings', 'readwrite');
    const settings = transaction.objectStore('settings');
    const read = settings.get('target');
    let changed = false;
    read.onsuccess = () => {
      if (read.result?.uid !== uid || read.result.avatar === avatar) return;
      settings.put({...read.result, avatar}, 'target');
      changed = true;
    };
    transaction.oncomplete = () => resolve(changed);
    transaction.onerror = () => reject(transaction.error || read.error);
    transaction.onabort = () => reject(transaction.error || new Error('头像保存中止'));
  });
}

/** 在同一读写事务内合并设置，防止多个浮窗覆盖彼此的月份记账。 */
export async function mergeSetting(key, entries) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('settings', 'readwrite');
    const settings = transaction.objectStore('settings');
    const read = settings.get(key);
    let failure;
    read.onsuccess = () => {
      try {
        settings.put({...read.result, ...entries}, key);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || read.error);
    transaction.onabort = () => reject(failure || transaction.error || new Error('数据库事务中止'));
  });
}
