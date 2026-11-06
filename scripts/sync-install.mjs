import {cpSync, existsSync, lstatSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// This opt-in developer command keeps an existing unpacked extension's loading path.
// It never runs as part of the portable release build.
const root = fileURLToPath(new URL('..', import.meta.url));
const destinationArgument = process.argv[2];
if (!destinationArgument) throw new Error('Usage: npm run sync:install -- /absolute/path/to/existing-extension');
const destination = path.resolve(destinationArgument);
const marker = path.join(path.dirname(destination), '.xiaowei-memory-legacy-install');
if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8').trim() !== 'xiaowei-memory') {
  throw new Error('The destination parent must contain a regular .xiaowei-memory-legacy-install file with content xiaowei-memory');
}
if (!existsSync(destination) || !lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink() || realpathSync(destination) !== destination) {
  throw new Error('The destination must be an existing directory without symlinked path components');
}
const destinationManifest = JSON.parse(readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
if (destinationManifest.manifest_version !== 3 || !['小微记忆', '微博备份'].includes(destinationManifest.name)) {
  throw new Error('The destination is not a known installation of this extension');
}
cpSync(path.join(root, 'extension'), destination, {recursive: true});
for (const name of ['LICENSE', 'PRIVACY.md', 'SECURITY.md']) cpSync(path.join(root, name), path.join(destination, name));
console.log('Updated the explicitly selected existing installation. Reload it in Chrome, then refresh the Weibo tab.');
