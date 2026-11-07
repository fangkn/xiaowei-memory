import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {posix} from 'node:path';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function startPreview() {
  // 随机监听端口与独立浏览器上下文保证测试不接触用户数据。
  const source = readFileSync(new URL('../scripts/preview.mjs', import.meta.url), 'utf8')
    .replace("const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));", `const root = ${JSON.stringify(projectRoot)};`)
    .replace("server.listen(4178,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4178'));",
      "server.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));");
  assert.ok(source.includes('server.listen(0,'));
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

function readStoredZip(bytes) {
  // 从中央目录读取尺寸，兼容真实流式打包器使用的 data descriptor。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder(), end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'ZIP must have a complete end record');
  const count = view.getUint16(end + 10, true), entries = new Map();
  let offset = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 10, true), 0, 'export entries must use ZIP STORE');
    const size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true);
    assert.equal(view.getUint32(offset + 20, true), size);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const local = view.getUint32(offset + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const localNameLength = view.getUint16(local + 26, true);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)), name);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    assert.ok(start + size <= end, `${name} must contain all bytes`);
    assert.equal(entries.has(name), false, `${name} must appear once`);
    entries.set(name, bytes.subarray(start, start + size));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  assert.equal(offset, end, 'central directory must match the end record');
  return entries;
}

async function seedSavedRecords(panel) {
  return panel.evaluate(async () => {
    const db = await import('/db.js'), {savePostRecord} = await import('/record-store.js');
    const uid = parent.previewState.uid, image = 'https://wx1.sinaimg.cn/large/xiaowei-offline-preview-photo-v1.png';
    const make = (id, month, text) => ({uid, id, identitySource: 'desktop-permalink',
      url: `https://weibo.com/${uid}/${id}`, author: '本机合成账号',
      createdAt: month ? `${month}-10T02:00:00.000Z` : null,
      dateRaw: month ? `${month}-10 10:00` : '未知日期', text,
      isRepost: false, repostText: '', repostUrl: '', images: [image], emoticons: [], fullText: true});
    const march = make('MarkdownMarch', '2026-03', '三月当前完整正文');
    await savePostRecord(db, march);
    await savePostRecord(db, {...march, text: '三月后来采集的不完整观察', fullText: false});
    await savePostRecord(db, make('MarkdownApril', '2026-04', '四月当前正文'));
    await savePostRecord(db, make('MarkdownUnknown', null, '未知日期当前正文'));
    const saved = await db.all('posts');
    return {count: saved.length, observations: saved.find(post => post.id === march.id).versions.filter(version => version.observationOnly).length};
  });
}

async function exportMarkdown(page, origin, selection) {
  const externalRequests = [], errors = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const handle = await page.locator('#weibo-obsidian-floating-panel iframe').elementHandle();
  const panel = await handle.contentFrame();
  assert.ok(panel, 'the real floating dashboard must load');
  await panel.locator('#wizardNext').waitFor({state: 'visible'});
  assert.deepEqual(await seedSavedRecords(panel), {count: 3, observations: 1});
  await panel.goto(panel.url());
  await panel.locator('#wizardLocalExport').click();
  assert.equal(await panel.locator('#total').textContent(), '3');
  await panel.locator('#step-export .options-details > summary').click();
  await panel.locator('#format').selectOption('markdown');
  await panel.locator('#images').check();
  await panel.locator('#batch').selectOption(selection);
  await panel.locator('#export').click();
  await panel.locator('#confirmExport').waitFor({state: 'visible', timeout: 90000});
  assert.equal(await panel.locator('#confirmExport').isEnabled(), true, await panel.locator('#exportStatus').textContent());
  const output = await page.evaluate(async () => {
    const blob = await (await fetch(previewState.lastFileURL)).blob();
    return {bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type,
      receipts: [...previewState.downloads.values()], mediaRequests: previewState.mediaRequests};
  });
  assert.equal(output.receipts.length, 1, 'all selected months must produce one download');
  assert.equal(output.receipts[0].state, 'complete');
  assert.match(output.receipts[0].filename, /\.zip$/);
  assert.equal(output.type, 'application/zip');
  assert.ok(output.mediaRequests > 0, 'the real media pipeline must read offline fixture images');
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'the test must not access external services');
  return {panel, entries: readStoredZip(Uint8Array.from(output.bytes))};
}

function verifyMonthFolders(entries, months) {
  const names = [...entries.keys()], text = name => new TextDecoder().decode(entries.get(name));
  assert.ok(entries.has('manifest.json'), 'the combined ZIP must contain its top-level manifest');
  assert.equal(names.some(name => /\.zip$/i.test(name)), false, 'month archives must not be nested ZIP files');
  assert.deepEqual([...new Set(names.filter(name => name.includes('/')).map(name => name.split('/')[0]))].sort(), [...months].sort());
  const mainNotes = names.filter(name => /\/(?:\d{4}-\d{2}|未知日期)\.md$/.test(name));
  assert.deepEqual(mainNotes.sort(), months.map(month => `${month}/${month}.md`).sort());
  for (const month of months) {
    assert.ok(entries.has(`${month}/manifest.json`), `${month} must have its own completeness manifest`);
    assert.ok(entries.has(`${month}/导入说明.md`), `${month} must have import instructions`);
    assert.ok(names.some(name => name.startsWith(`${month}/assets/`)), `${month} must contain its own image assets`);
  }
  let imageCount = 0;
  for (const name of names.filter(name => name.endsWith('.md'))) {
    for (const match of text(name).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const path = match[1];
      assert.match(path, /^assets\//, `${name} must use a relative assets path`);
      const target = posix.normalize(posix.join(posix.dirname(name), path));
      assert.ok(entries.has(target), `${name}: ${path} must resolve within the final ZIP`);
      assert.deepEqual([...entries.get(target).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'resolved asset must be the real PNG fixture');
      imageCount++;
    }
  }
  assert.equal(imageCount, months.length + 1, 'all current and historical image references must be kept');
  assert.match(text('2026-03/2026-03.md'), /三月当前完整正文/);
  assert.doesNotMatch(text('2026-03/2026-03.md'), /三月后来采集的不完整观察|四月当前正文|未知日期当前正文/);
  assert.match(text('2026-03/2026-03-history.md'), /三月后来采集的不完整观察/);
  assert.match(text('2026-03/2026-03-history.md'), /不完整观察/);
  if (months.includes('2026-04')) assert.match(text('2026-04/2026-04.md'), /四月当前正文/);
  if (months.includes('未知日期')) assert.match(text('未知日期/未知日期.md'), /未知日期当前正文/);
  return JSON.parse(text('manifest.json'));
}

test('Markdown exports real saved months as one ZIP with directly usable month folders', {timeout: 120000}, async () => {
  const preview = await startPreview();
  const {chromium} = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, headless: true});
    for (const selection of ['all', '2026-03']) {
      const context = await browser.newContext({viewport: {width: 1280, height: 900}});
      try {
        const page = await context.newPage();
        const {panel, entries} = await exportMarkdown(page, preview.origin, selection);
        const months = selection === 'all' ? ['2026-03', '2026-04', '未知日期'] : ['2026-03'];
        const manifest = verifyMonthFolders(entries, months);
        assert.equal(manifest.format, 'markdown');
        assert.deepEqual(manifest.months.map(month => month.month).sort(), months.map(month => month === '未知日期' ? 'unknown' : month).sort());
        await panel.locator('#confirmExport').click();
        await panel.locator('#exportDone').waitFor({state: 'visible'});
        assert.equal(await page.evaluate(() => previewState.downloads.size), 1, 'confirmation must not start another download');
      } finally { await context.close(); }
    }
  } finally {
    if (browser) await browser.close();
    preview.close();
  }
});
