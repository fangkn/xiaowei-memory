/** Shared strict timestamp classification for grouping and archive paths. */
export function dateParts(raw){
  if(typeof raw!=='string')return null;
  const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/);
  if(!m)return null;const [,y,mon,d,h,min,sec]=m.map(Number);
  if(mon<1||mon>12||d<1||d>new Date(Date.UTC(y,mon,0)).getUTCDate()||h>23||min>59||sec>59)return null;
  const time=Date.parse(raw);if(!Number.isFinite(time))return null;
  const iso=new Date(time+8*3600000).toISOString();if(!/^\d{4}-/.test(iso))return null;return {time,day:iso.slice(0,10),year:iso.slice(0,4),month:iso.slice(0,7),display:iso.slice(0,19).replace('T',' ')};
}
