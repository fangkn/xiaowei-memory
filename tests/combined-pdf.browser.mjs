import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function startPreview() {
  // 测试独立启动同一预览页面，只改监听端口，避免占用用户正在使用的 4178。
  const source = readFileSync(new URL('../scripts/preview.mjs', import.meta.url), 'utf8')
    .replace("const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));", `const root = ${JSON.stringify(projectRoot)};`)
    .replace("server.listen(4178,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4178'));",
      "server.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));");
  assert.ok(source.includes('server.listen(0,'), 'preview must use an isolated random port');
  const child = spawn(process.execPath, ['--input-type=module'], {cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Preview failed to start: ${output}`)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited (${code}): ${output}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Local: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', data => { output += data; });
  });
  child.stdin.end(source);
  try { return {origin: await ready, close: () => child.kill()}; }
  catch (error) { child.kill(); throw error; }
}

test('combined PDF exports two saved months in one real PDF and preserves the selected format after reload', {timeout: 120000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    await page.route('**/*', route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.origin);
    const handle = await page.locator('#weibo-obsidian-floating-panel iframe').elementHandle();
    const panel = await handle.contentFrame();
    assert.ok(panel, 'the actual floating dashboard must load');
    await panel.locator('#wizardNext').click();
    await panel.locator('#pageOptions summary').click();
    await panel.locator('#scroll').uncheck();
    await panel.locator('#wizardStart').click();
    await panel.locator('#wizardToExport').click();
    assert.equal(await panel.locator('#total').textContent(), '2');
    const saved = await panel.evaluate(async () => (await (await import('/db.js')).all('posts')).map(post => post.id));
    assert.deepEqual(saved.sort(), ['Offline202610', 'Offline202611'], 'the fixture repost must not be saved or exported');

    await panel.locator('#step-export .options-details > summary').click();
    await panel.locator('#format').selectOption('pdf-combined');
    await panel.locator('#batch').selectOption('all');
    assert.match(await panel.locator('#format option:checked').textContent(), /全部合成一份/);
    await panel.locator('#images').check();
    await panel.locator('#export').click();
    await panel.locator('#confirmExport').waitFor({state: 'visible', timeout: 90000});
    assert.equal(await panel.locator('#confirmExport').isEnabled(), true);
    assert.doesNotMatch(await panel.locator('#exportStatus').textContent(), /ZIP|解压/);

    const output = await page.evaluate(async () => {
      const {PDFDocument, PDFName, decodePDFRawStream} = await import('/vendor/pdf-lib.esm.min.js');
      const blob = await (await fetch(previewState.lastFileURL)).blob();
      const document = await PDFDocument.load(await blob.arrayBuffer());
      const text = document.getPages().map(page => {
        const mapping = new Map(), fonts = page.node.Resources().lookup(PDFName.of('Font'));
        for (const [, ref] of fonts.entries()) {
          const stream = document.context.lookup(ref).lookup(PDFName.of('ToUnicode'));
          if (!stream) continue;
          const cmap = new TextDecoder().decode(decodePDFRawStream(stream).decode());
          for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
            for (const pair of block[1].matchAll(/<([0-9A-F]+)>\s*<([0-9A-F]+)>/gi)) {
              mapping.set(pair[1].toUpperCase(), String.fromCharCode(...(pair[2].match(/.{4}/g) || []).map(value => parseInt(value, 16))));
            }
          }
        }
        const contents = page.node.Contents(), refs = contents.asArray ? contents.asArray() : [contents];
        return refs.map(ref => {
          const commands = new TextDecoder().decode(decodePDFRawStream(document.context.lookup(ref)).decode());
          return [...commands.matchAll(/<([0-9A-F]+)>\s*Tj/gi)].map(match => (match[1].match(/.{4}/g) || []).map(glyph => mapping.get(glyph.toUpperCase()) || '').join('')).join('\n');
        }).join('\n');
      }).join('\n');
      const links=document.getPages().flatMap(page=>(page.node.Annots()?.asArray()||[]).map(ref=>{
        const annotation=document.context.lookup(ref);
        return annotation.lookup(PDFName.of('A'))?.lookup(PDFName.of('URI'))?.decodeText();
      }).filter(Boolean));
      return {receipts: [...previewState.downloads.values()], type: blob.type, size: blob.size,
        title: document.getTitle(), pages: document.getPageCount(), text, links, mediaRequests: previewState.mediaRequests};
    });
    assert.equal(output.receipts.length, 1);
    assert.equal(output.receipts[0].state, 'complete');
    assert.match(output.receipts[0].filename, /\.pdf$/);
    assert.equal(output.type, 'application/pdf');
    assert.ok(output.size > 1000 && output.pages > 0);
    assert.match(output.title, /原创/);
    assert.ok(output.mediaRequests >= 2, 'real offline photos and emoticons must be prepared');
    assert.match(output.text, /2026-10 的离线记忆/);
    assert.match(output.text, /2026-11 的离线记忆/);
    assert.ok(output.text.indexOf('2026-10 的离线记忆') < output.text.indexOf('2026-11 的离线记忆'));
    assert.doesNotMatch(output.text, /这条合成转发应当被过滤|示例转发正文/);
    assert.match(output.text.replace(/\n/g,''), /@离线笔记/);
    assert.match(output.text.replace(/\n/g,''), /#日常记录#/);
    assert.doesNotMatch(output.text, /https?:\/\/|%E[0-9A-F]/);
    assert.ok(output.links.includes('https://weibo.com/n/'+encodeURIComponent('离线笔记')));
    assert.ok(output.links.includes('https://s.weibo.com/weibo?q='+encodeURIComponent('#日常记录#')));

    await panel.locator('#confirmExport').click();
    await panel.locator('#exportDone').waitFor({state: 'visible'});
    assert.doesNotMatch(await panel.locator('#doneHint').textContent(), /ZIP|解压/);
    const stored = await panel.evaluate(async () => {
      const db = await import('/db.js'), {monthLedgerKey} = await import('/monthly.js');
      const uid = parent.previewState.uid;
      return {options: await db.get('settings', 'options'),
        combined: await db.get('settings', monthLedgerKey(uid, {format: 'pdf-combined', originalOnly: true})),
        monthly: await db.get('settings', monthLedgerKey(uid, {format: 'pdf', originalOnly: true}))};
    });
    assert.equal(stored.options.format, 'pdf-combined');
    assert.deepEqual(Object.keys(stored.combined).sort(), ['2026-10', '2026-11']);
    assert.equal(stored.monthly, undefined, 'combined confirmation must not mark the separate monthly format as exported');

    await panel.goto(panel.url());
    await panel.locator('#wizardLocalExport').click();
    await panel.locator('#step-export .options-details > summary').click();
    assert.equal(await panel.locator('#format').inputValue(), 'pdf-combined');
    await panel.locator('#format').selectOption('pdf');
    assert.match(await panel.locator('#format option:checked').textContent(), /每月一份/);
    await panel.locator('#batch').selectOption('all');
    assert.match(await panel.locator('#export').textContent(), /月度 PDF/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});
