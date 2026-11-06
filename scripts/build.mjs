import {mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildZip} from '../extension/archive.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const compareNames = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Convert filesystem paths to relative, portable ZIP entry names. */
export function archivePath(root, file, pathImplementation = path) {
  const relative = pathImplementation.relative(root, file);
  const name = relative.split(pathImplementation.sep).join('/');
  if (!name || pathImplementation.isAbsolute(relative) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`File is outside the package root: ${file}`);
  }
  return name;
}

/** Collect regular files only; symlinks must never pull external files into a release. */
function collectFiles(directory, archiveRoot = directory) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Symlinks are not allowed in release files: ${directory}`);
  const result = [];
  for (const entry of readdirSync(directory, {withFileTypes: true}).sort(compareNames)) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release files: ${file}`);
    if (entry.isDirectory()) result.push(...collectFiles(file, archiveRoot));
    else if (entry.isFile()) result.push({name: archivePath(archiveRoot, file), data: new Uint8Array(readFileSync(file))});
  }
  return result;
}

function readEntry(root, name) {
  const file = path.join(root, name);
  if (!lstatSync(file).isFile()) throw new Error(`Release input must be a regular file: ${name}`);
  return {name, data: new Uint8Array(readFileSync(file))};
}

function writeUnpacked(directory, entries) {
  rmSync(directory, {recursive: true, force: true});
  for (const entry of entries) {
    const destination = path.join(directory, ...entry.name.split('/'));
    mkdirSync(path.dirname(destination), {recursive: true});
    writeFileSync(destination, entry.data);
  }
}

/** Build deterministic release artifacts without modifying any installed extension. */
export function buildRelease(root = projectRoot, output = path.join(root, 'dist'), {target = 'all'} = {}) {
  if (!['all', 'chrome', 'edge'].includes(target)) throw new Error(`Unknown browser target: ${target}`);
  const manifest = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error('Release requires a Manifest V3 extension with a valid numeric version');
  }
  const browsers = target === 'all' ? ['chrome', 'edge'] : [target];
  const extensionEntries = collectFiles(path.join(root, 'extension'));
  for (const name of ['LICENSE', 'PRIVACY.md', 'SECURITY.md']) extensionEntries.push(readEntry(root, name));
  extensionEntries.sort(compareNames);

  const sources = [];
  for (const directory of ['extension', 'scripts', 'tests', 'docs', '.github']) {
    const absolute = path.join(root, directory);
    if (existsSync(absolute)) sources.push(...collectFiles(absolute, root));
  }
  for (const name of [
    'package.json', 'package-lock.json', 'README.md', '小微记忆-使用说明.md',
    'PRIVACY.md', 'LICENSE', 'TEST-REPORT.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
    'SECURITY.md', '.gitignore', '.gitattributes', '.editorconfig',
  ]) {
    if (existsSync(path.join(root, name))) sources.push(readEntry(root, name));
  }
  sources.sort(compareNames);
  const extensionZip = buildZip(extensionEntries);
  const sourceZip = buildZip(sources);

  mkdirSync(output, {recursive: true});
  const packages = [];
  for (const browser of browsers) {
    const filename = `xiaowei-memory-${browser}-v${manifest.version}.zip`;
    writeFileSync(path.join(output, filename), extensionZip);
    writeUnpacked(path.join(output, browser), extensionEntries);
    packages.push(filename);
  }
  // Preserve the existing generic package and loading path for current users.
  if (target === 'all') {
    writeFileSync(path.join(output, 'xiaowei-memory-extension.zip'), extensionZip);
    writeUnpacked(path.join(output, 'unpacked'), extensionEntries);
  }
  writeFileSync(path.join(output, 'xiaowei-memory-source.zip'), sourceZip);
  return {extensionFiles: extensionEntries.length, sourceFiles: sources.length, packages};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !/^--target=(all|chrome|edge)$/.test(args[0]))) {
    throw new Error('Usage: node scripts/build.mjs [--target=all|chrome|edge]');
  }
  const result = buildRelease(projectRoot, path.join(projectRoot, 'dist'), {target: args[0]?.split('=')[1] || 'all'});
  console.log(`Created ${result.packages.join(', ')} (${result.extensionFiles} files each), browser loading directories, and source ZIP (${result.sourceFiles} files).`);
}
