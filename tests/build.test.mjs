import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {archivePath, buildRelease} from '../scripts/build.mjs';
import {buildZip} from '../extension/archive.js';

function fixture(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'xiaowei-build-'));
  t.after(() => rmSync(workspace, {recursive: true, force: true}));
  const root = path.join(workspace, 'project');
  const put = (name, contents = name) => {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), {recursive: true});
    writeFileSync(destination, contents);
  };
  for (const name of ['extension/manifest.json', 'extension/vendor/library.js', 'extension/vendor/LICENSE.txt', 'scripts/build.mjs', 'tests/example.test.mjs', 'docs/guide.md', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', '.gitignore']) put(name);
  return {workspace, root, put};
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

test('Windows and POSIX filesystem paths yield safe relative ZIP entries', () => {
  for (const [implementation, root, file] of [
    [path.win32, 'C:\\projects\\memory\\extension', 'C:\\projects\\memory\\extension\\vendor\\fontkit.js'],
    [path.posix, '/projects/memory/extension', '/projects/memory/extension/vendor/fontkit.js'],
  ]) {
    const name = archivePath(root, file, implementation);
    assert.equal(name, 'vendor/fontkit.js');
    assert.doesNotThrow(() => buildZip([{name, data: 'module'}]));
  }
  assert.throws(() => archivePath('C:\\safe', 'D:\\secret.txt', path.win32));
  assert.throws(() => archivePath('/safe', '/secret.txt', path.posix));
});

test('release archives include legal documents and reproducible sources, excluding generated or local files', t => {
  const {root, put} = fixture(t);
  for (const name of ['.env', '.git/config', 'node_modules/private/index.js', 'dist/old.zip', 'notes/private.pdf', 'xiaowei-memory-extension.zip']) put(name, 'LOCAL ONLY');
  const result = buildRelease(root);
  const extension = zipEntries(readFileSync(path.join(root, 'dist/xiaowei-memory-extension.zip')));
  assert.equal(extension.get('LICENSE').toString(), 'LICENSE');
  assert.equal(extension.get('PRIVACY.md').toString(), 'PRIVACY.md');
  assert.equal(extension.get('SECURITY.md').toString(), 'SECURITY.md');
  assert.ok(extension.has('vendor/LICENSE.txt'));
  assert.ok(!extension.has('README.md'));
  for (const [name, data] of extension) assert.deepEqual(readFileSync(path.join(root, 'dist/unpacked', name)), data);
  const source = zipEntries(readFileSync(path.join(root, 'dist/xiaowei-memory-source.zip')));
  for (const name of ['docs/guide.md', '.github/workflows/ci.yml', '.gitignore', 'package-lock.json', 'LICENSE', 'PRIVACY.md']) assert.ok(source.has(name), name);
  assert.ok([...source.keys()].every(name => !name.includes('private') && !name.startsWith('dist/') && !name.endsWith('.zip') && name !== '.env' && !name.startsWith('.git/')));
  assert.equal(result.extensionFiles, extension.size);
  const first = readFileSync(path.join(root, 'dist/xiaowei-memory-source.zip'));
  buildRelease(root);
  assert.deepEqual(readFileSync(path.join(root, 'dist/xiaowei-memory-source.zip')), first);
});

test('ordinary build never updates an existing adjacent legacy installation', t => {
  const {root, workspace} = fixture(t);
  const legacy = path.join(workspace, 'weibo-backup');
  const install = path.join(legacy, 'weibo-obsidian-backup-extension');
  mkdirSync(install, {recursive: true});
  writeFileSync(path.join(legacy, '.xiaowei-memory-legacy-install'), 'xiaowei-memory');
  writeFileSync(path.join(install, 'manifest.json'), 'EXISTING INSTALLATION');
  buildRelease(root);
  assert.equal(readFileSync(path.join(install, 'manifest.json'), 'utf8'), 'EXISTING INSTALLATION');
});

test('release rejects symlinked input files instead of packaging outside data', t => {
  const {root, workspace} = fixture(t);
  const secret = path.join(workspace, 'outside.txt');
  writeFileSync(secret, 'OUTSIDE');
  try {
    symlinkSync(secret, path.join(root, 'extension/linked.txt'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows account does not have symlink creation privilege');
    throw error;
  }
  assert.throws(() => buildRelease(root), /Symlinks are not allowed/);
});
