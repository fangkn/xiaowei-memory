import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
import './verify-vendor.mjs';
const extension = 'extension';
for(const f of readdirSync(extension).filter(f=>f.endsWith('.js')))execFileSync(process.execPath,['--check',`${extension}/${f}`],{stdio:'inherit'});
for(const f of readdirSync('scripts').filter(f=>f.endsWith('.mjs')))execFileSync(process.execPath,['--check',`scripts/${f}`],{stdio:'inherit'});
const m=JSON.parse(readFileSync(`${extension}/manifest.json`,'utf8'));
const packageMetadata=JSON.parse(readFileSync('package.json','utf8'));
if(m.version!==packageMetadata.version)throw new Error('Package and extension versions must match');
for(const file of ['LICENSE','PRIVACY.md','SECURITY.md','README.md','package-lock.json'])if(!readFileSync(file,'utf8').trim())throw new Error(`Missing release file: ${file}`);
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
if(lock.version!==m.version||lock.packages?.['']?.version!==m.version)throw new Error('Lock file version must match the manifest');
if(m.manifest_version!==3||m.permissions.includes('cookies')||m.permissions.includes('debugger'))throw new Error('Manifest permissions invalid');
for(const icons of [m.icons,m.action.default_icon]){
  for(const size of [16,24,32,48,128]){
    const file=icons?.[size];
    if(!file||!/^icons\/icon-\d+\.png$/.test(file))throw new Error(`Missing icon declaration: ${size}`);
    const png=readFileSync(`${extension}/${file}`);
    if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.readUInt32BE(16)!==size||png.readUInt32BE(20)!==size)throw new Error(`Invalid PNG icon: ${file}`);
  }
}
for(const f of ['dashboard.js','browser-export.js','media-data.js','media-referrer.js','export-runner.js','export-files.js','zip-stream.js','zip-reader.js','content.js','archive.js','db.js','model.js','floating-panel.js','panel-ui.js','wizard-state.js','monthly-pdf.js','vendor/pdf-lib.esm.min.js','vendor/fontkit.esm.min.js','fonts/NotoSansSC-Regular.ttf'])if(!readFileSync(`${extension}/${f}`).length)throw new Error(`Missing ${f}`);
if(m.action.default_popup!=='launcher.html')throw new Error('Toolbar must use the guided launcher');
for(const file of ['launcher.html','launcher.js','launcher.css'])if(!readFileSync(`${extension}/${file}`).length)throw new Error(`Missing ${file}`);
const html=readFileSync(`${extension}/dashboard.html`,'utf8');
if(!html.includes(`<span class="version">v${m.version}</span>`))throw new Error('Dashboard version must match the manifest');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
if(new Set(ids).size!==ids.length)throw new Error('Duplicate dashboard IDs');
for(const file of ['dashboard.js','panel-ui.js']){
  const source=readFileSync(`${extension}/${file}`,'utf8');
  for(const match of source.matchAll(/(?:\$\(|getElementById\()'([^']+)'/g))if(!ids.includes(match[1]))throw new Error(`Missing dashboard element ${match[1]}`);
}
console.log('Syntax, manifest, release metadata and entry points passed.');
