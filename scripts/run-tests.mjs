import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Resolve test files here because Windows shells do not expand the npm script glob.
const root = fileURLToPath(new URL('..', import.meta.url));
const kind = process.argv[2] || 'unit';
if (!['unit', 'browser'].includes(kind)) throw new Error('Expected unit or browser test suite');
const suffix = kind === 'browser' ? '.browser.mjs' : '.test.mjs';
const files = readdirSync(path.join(root, 'tests')).filter(file => file.endsWith(suffix)).sort().map(file => path.join(root, 'tests', file));
if (!files.length) throw new Error(`No ${kind} tests found`);
const result = spawnSync(process.execPath, ['--test', ...files], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
