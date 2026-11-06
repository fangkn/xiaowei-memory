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

/** Build deterministic release artifacts without modifying any installed extension. */
export function buildRelease(root = projectRoot, output = path.join(root, 'dist')) {
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
  writeFileSync(path.join(output, 'xiaowei-memory-extension.zip'), extensionZip);
  writeFileSync(path.join(output, 'xiaowei-memory-source.zip'), sourceZip);
  const unpacked = path.join(output, 'unpacked');
  rmSync(unpacked, {recursive: true, force: true});
  for (const entry of extensionEntries) {
    const destination = path.join(unpacked, ...entry.name.split('/'));
    mkdirSync(path.dirname(destination), {recursive: true});
    writeFileSync(destination, entry.data);
  }
  return {extensionFiles: extensionEntries.length, sourceFiles: sources.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildRelease();
  console.log(`Created extension ZIP (${result.extensionFiles} files), source ZIP (${result.sourceFiles} files), and dist/unpacked.`);
}
