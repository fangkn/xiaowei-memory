import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('extension/DEPENDENCIES.json', root), 'utf8'));
let checked = 0;
for (const dependency of manifest.dependencies) {
  for (const artifact of dependency.artifacts) {
    if (!/^(vendor|fonts)\/[A-Za-z0-9_.-]+$/.test(artifact.path)) throw new Error('Invalid dependency path');
    const bytes = readFileSync(new URL(`extension/${artifact.path}`, root));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== artifact.sha256) throw new Error(`Dependency checksum mismatch: ${artifact.path}`);
    checked++;
  }
}
console.log(`Verified ${checked} bundled dependency files (SHA-256).`);
