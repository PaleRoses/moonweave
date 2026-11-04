import assert from 'node:assert/strict';
import {parseSync} from '@babel/core';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, cp, readdir, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const stage = resolve(root, 'build/package');
const archive = resolve(root, `dist/downloads/moonweave-surfaces-${sourcePackage.version}.tgz`);
const consumer = await mkdtemp(resolve(tmpdir(), 'moonweave-consumer-'));
const compiler = resolve(root, 'node_modules/typescript/bin/tsc');
const options = {
  target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
  noEmit: true, allowJs: false, allowImportingTsExtensions: false, skipLibCheck: false,
};
const run = (command, args, cwd = consumer) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: 'pipe',
});
const npm = args => run('npm', ['--loglevel=error', ...args]);
const installFlags = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];

async function fixture(name) {
  await copyFile(resolve(root, 'tests/consumer', name), resolve(consumer, name));
}
async function checkTypes(name, files, lib) {
  const config = resolve(consumer, `tsconfig.${name}.json`);
  await writeFile(config, JSON.stringify({compilerOptions: {...options, lib}, files}));
  run(process.execPath, [compiler, '-p', config]);
}
async function filesIn(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) names.push(...await filesIn(resolve(directory, entry.name), name + '/'));
    else if (entry.isFile()) names.push(name);
    else throw new Error(`Unexpected package link: ${name}`);
  }
  return names.sort();
}
// Recursive constructor inference can otherwise emit an elided `any` without
// a source diagnostic. Audit the actual packed declarations, not a facade.
function rejectAnyDeclaration(node, filename) {
  if (!node || typeof node !== 'object') return;
  assert.notEqual(node.type, 'TSAnyKeyword', `Unbounded any in generated public declaration: ${filename}`);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) rejectAnyDeclaration(child, filename);
    else if (value && typeof value === 'object') rejectAnyDeclaration(value, filename);
  }
}
const copiedPeers = new Set();
async function copyPeer(name, from = root) {
  // Locate package folders using Node's search paths, without requiring a peer
  // to expose its package.json through exports. Preserve nested installations.
  const paths = createRequire(resolve(from, 'package.json')).resolve.paths(name);
  for (const modules of paths) {
    const source = resolve(modules, name);
    let metadata;
    try { metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (copiedPeers.has(source)) return;
    const path = relative(root, source);
    assert(path.startsWith('node_modules' + sep), `Install the host peer in this checkout: ${name}`);
    copiedPeers.add(source);
    const destination = resolve(consumer, path);
    await mkdir(dirname(destination), {recursive: true});
    await cp(source, destination, {recursive: true, dereference: true});
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyPeer(dependency, source);
    return;
  }
  throw new Error(`Missing host peer ${name}; run npm ci before checking the package.`);
}

try {
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  npm(['install', ...installFlags, archive]);
  const installed = resolve(consumer, 'node_modules', sourcePackage.name);
  const pkg = JSON.parse(await readFile(resolve(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, sourcePackage.name);
  assert.equal(pkg.version, sourcePackage.version, 'build the current version before checking its package');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './core', './three', './optimize']);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, sourcePackage.license);
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.peerDependenciesMeta.three.optional, true);

  // Compare npm's allowlisted stage inventory with the actual installed tarball.
  const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], stage));
  const names = await filesIn(installed);
  assert.deepEqual(names, packed.files.map(file => file.path).sort());
  assert(names.includes('types/core/algebra.d.mts'));
  for (const name of names) {
    assert(!/^(?:src|lab|tools|tests)\//.test(name), `Development source leaked into the package: ${name}`);
    assert(!/\.(?:ts|mts|tsx)$/.test(name) || /\.d\.mts$/.test(name), `Implementation TypeScript leaked: ${name}`);
    assert.deepEqual(await readFile(resolve(installed, name)), await readFile(resolve(stage, name)),
      `The installed archive differs from the build stage: ${name}`);
    if (name.endsWith('.d.mts')) {
      const declaration = await readFile(resolve(installed, name), 'utf8');
      rejectAnyDeclaration(parseSync(declaration, {filename: name, babelrc: false, configFile: false,
        parserOpts: {sourceType: 'module', plugins: [['typescript', {dts: true}]]}}), name);
    }
  }
  for (const entry of Object.values(pkg.exports)) {
    assert.equal(Object.keys(entry)[0], 'types');
    for (const target of Object.values(entry)) assert(names.includes(target.slice(2)), `Missing export ${target}`);
  }

  const require = createRequire(resolve(consumer, 'package.json'));
  for (const name of ['three', 'solid-js', 'effect']) {
    assert.throws(() => require.resolve(name), {code: 'MODULE_NOT_FOUND'}, `${name} must be absent for the core check`);
  }
  await fixture('runtime.mjs');
  await fixture('core.mts');
  run(process.execPath, ['runtime.mjs']);
  await checkTypes('core', ['core.mts'], ['ES2022']);

  // Copy the exact pinned host dependency closure, with no checkout symlinks or
  // assumption that a restored node_modules tree also restored npm's cache.
  await copyPeer('three');
  await copyPeer('@types/three');
  await fixture('three.mjs');
  run(process.execPath, ['three.mjs']);
  const publicConfig = JSON.parse(await readFile(resolve(root, 'tsconfig.public.json'), 'utf8'));
  for (const name of publicConfig.files) {
    await mkdir(dirname(resolve(consumer, name)), {recursive: true});
    await copyFile(resolve(root, name), resolve(consumer, name));
  }
  await checkTypes('public', publicConfig.files, ['ES2022', 'DOM', 'DOM.Iterable']);
  console.log(JSON.stringify({
    version: pkg.version, files: names.length,
    installedTarball: archive, sourceFreeDeclarations: true, generatedDeclarationsWithoutAny: true, coreWithoutPeers: true,
    sharedModuleIdentity: true, threeAdapter: true, strictNodeNext: true,
    copiedHostPackages: copiedPeers.size,
  }, null, 2));
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(consumer, {recursive: true, force: true});
}
