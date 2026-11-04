/** Default destinations for current release evidence; callers may always override them. */
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const {version} = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const release = version.split('.').slice(0, 2).join('.');

export function evidencePath(filename) {
  const path = resolve(root, 'docs/evidence', release, filename);
  mkdirSync(dirname(path), {recursive: true});
  return path;
}
