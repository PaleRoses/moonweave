import {build} from 'esbuild';
import {transformAsync} from '@babel/core';
import solidPreset from 'babel-preset-solid';
import typescriptPreset from '@babel/preset-typescript';
import {mkdir, readFile, writeFile, copyFile, cp, rm, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const dist = resolve(root, 'dist');
const stage = resolve(root, 'build/package');
// Both directories contain generated output only. Every build starts clean.
await rm(dist, {recursive: true, force: true});
await rm(stage, {recursive: true, force: true});
await mkdir(resolve(dist, 'downloads'), {recursive: true});
await mkdir(stage, {recursive: true});

const forbidden = /(?:three\.module|(?:road|cliff|trail|place|sanctuary|slate)-|studio|node_modules)/;
const libraries = {};
const entries = {'moonweave': 'index', 'moonweave-core': 'core', 'moonweave-three': 'three', 'moonweave-optimize': 'optimize'};
// One shared implementation across public entry points preserves graph identities
// and caches when a host imports its authoring API and renderer adapter separately.
const libraryBuild = await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, `src/${entry}.mjs`])),
  outdir: 'dist', outExtension: {'.js': '.mjs'}, chunkNames: 'chunks/[name]-[hash]',
  bundle: true, splitting: true, format: 'esm', platform: 'neutral', target: 'es2022',
  treeShaking: true, minify: false, metafile: true, legalComments: 'inline',
});
const outputs = libraryBuild.metafile.outputs;
const moduleBytes = new Map();
for (const path of Object.keys(outputs)) {
  const bytes = await readFile(resolve(root, path));
  moduleBytes.set(path, bytes);
  const relative = path.slice('dist/'.length);
  await mkdir(dirname(resolve(stage, relative)), {recursive: true});
  await copyFile(resolve(root, path), resolve(stage, relative));
}
for (const [name, entry] of Object.entries(entries)) {
  const files = new Set();
  function collect(path) {
    if (files.has(path)) return;
    files.add(path);
    for (const dependency of outputs[path].imports) {
      if (dependency.external) throw new Error(`Unexpected external library import: ${dependency.path}`);
      collect(dependency.path);
    }
  }
  collect(`dist/${name}.mjs`);
  const modules = [...new Set([...files].flatMap(path => Object.keys(outputs[path].inputs)))].sort();
  for (const path of modules) {
    if (forbidden.test(path)) throw new Error(`Unexpected library dependency: ${path}`);
    if (entry !== 'optimize' && /src\/core\/(?:effects|optimize)\.mts$/.test(path)) {
      throw new Error(`Optional optimization code entered ${entry}: ${path}`);
    }
    if ((entry === 'core' || entry === 'optimize') && path.startsWith('src/three/')) {
      throw new Error(`Pure core imported a renderer adapter: ${path}`);
    }
  }
  libraries[entry] = {
    entry: `${name}.mjs`,
    modules,
    sourceBytes: modules.reduce((sum, path) => sum + libraryBuild.metafile.inputs[path].bytes, 0),
    runtimeBytes: [...files].reduce((sum, path) => sum + moduleBytes.get(path).byteLength, 0),
    files: Object.fromEntries([...files].sort().map(path => [path.slice('dist/'.length), {
      bytes: moduleBytes.get(path).byteLength,
      sha256: createHash('sha256').update(moduleBytes.get(path)).digest('hex'),
    }])),
  };
}

const atelierBuild = await build({
  absWorkingDir: root, entryPoints: ['lab/index.tsx'], outfile: 'dist/lab.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof', logLevel: 'info', metafile: true,
  conditions: ['browser'],
  plugins: [{name: 'solid', setup(builder) {
    builder.onLoad({filter: /\.tsx$/}, async ({path}) => {
      const result = await transformAsync(await readFile(path, 'utf8'), {
        filename: path, babelrc: false, configFile: false,
        presets: [[solidPreset, {generate: 'dom', hydratable: false}], [typescriptPreset, {onlyRemoveTypeImports: true}]],
      });
      if (!result?.code) throw new Error(`Solid compilation produced no output: ${path}`);
      return {contents: result.code, loader: 'js', resolveDir: dirname(path)};
    });
  }}],
});
for (const name of ['index.html', 'guide.html']) {
  const html = (await readFile(resolve(root, 'lab', name), 'utf8'))
    .replaceAll('{{VERSION}}', pkg.version)
    .replaceAll('{{EDITION}}', pkg.version.split('.')[1].padStart(3, '0'));
  await writeFile(resolve(dist, name), html);
}
await copyFile(resolve(root, 'THREE-LICENSE.txt'), resolve(dist, 'THREE-LICENSE.txt'));
// Declaration imports mirror the source folders. Consumers receive declarations,
// never the TypeScript implementation or the atelier's compiler configuration.
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p',
  resolve(root, 'tsconfig.declarations.json')], {cwd: root, stdio: 'inherit'});
// Source runs directly on Node's type stripping. Published declarations resolve
// through .mjs to their sibling .d.mts files, without requiring source TypeScript.
const declarations = new Map();
async function declarationSpecifiers(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path=resolve(directory,entry.name);
    if(entry.isDirectory())await declarationSpecifiers(path);
    else if(entry.name.endsWith('.d.mts')) {
      const text=await readFile(path,'utf8');
      const normalized=text.replace(/(['"])(\.{1,2}\/[^'"\n]+)\.mts\1/g,'$1$2.mjs$1');
      declarations.set(path, normalized);
      await writeFile(path, normalized);
    }
  }
}
await declarationSpecifiers(resolve(stage,'types'));
// Emit owners, then retain the declaration closure of the public exports.
// Runtime-only JS kernels need no type payload in a source-free consumer package.
const liveDeclarations = new Set();
function retainDeclaration(path) {
  if (liveDeclarations.has(path)) return;
  const declaration = declarations.get(path);
  if (declaration === undefined) throw new Error(`Missing generated declaration: ${path}`);
  liveDeclarations.add(path);
  for (const match of declaration.matchAll(/(['"])(\.{1,2}\/[^'"\n]+)\.mjs\1/g)) {
    retainDeclaration(resolve(dirname(path), `${match[2]}.d.mts`));
  }
}
for (const entry of Object.values(entries)) retainDeclaration(resolve(stage, `types/${entry}.d.mts`));
await Promise.all([...declarations.keys()].filter(path => !liveDeclarations.has(path)).map(path => rm(path)));
await mkdir(resolve(stage, 'docs'), {recursive: true});
for (const name of ['TEXTURING.md', 'GRAMMAR.md', 'ARCHITECTURE.md', 'PACKAGING.md', 'COLOR-STUDY.md', 'APPLICATIONS.md', 'FILTERING.md', 'OPTIMIZATION.md', 'SHARING.md', 'MARKS.md', 'COLOR.md']) {
  await copyFile(resolve(root, 'docs', name), resolve(stage, 'docs', name));
}
await copyFile(resolve(root, 'docs/PACKAGE.md'), resolve(stage, 'README.md'));
await copyFile(resolve(root, 'THREE-LICENSE.txt'), resolve(stage, 'THREE-LICENSE.txt'));
await copyFile(resolve(root, 'src/color/SPECTRAL-LICENSE.txt'), resolve(stage, 'SPECTRAL-LICENSE.txt'));
await copyFile(resolve(root, 'src/color/SPECTRAL-LICENSE.txt'), resolve(dist, 'SPECTRAL-LICENSE.txt'));
await copyFile(resolve(root, 'src/color/COLOR-LICENSE.txt'), resolve(stage, 'COLOR-LICENSE.txt'));
await copyFile(resolve(root, 'src/color/COLOR-LICENSE.txt'), resolve(dist, 'COLOR-LICENSE.txt'));
await writeFile(resolve(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: 'module', sideEffects: false,
  description: pkg.description, license: pkg.license,
  exports: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [
    entry === 'index' ? '.' : `./${entry}`,
    {types: `./types/${entry}.d.mts`, import: `./${name}.mjs`, default: `./${name}.mjs`},
  ])),
  files: [...Object.keys(entries).map(name => `${name}.mjs`),
    'chunks', 'types', 'docs', 'examples', 'BUILD-MANIFEST.json', 'THREE-LICENSE.txt', 'SPECTRAL-LICENSE.txt', 'COLOR-LICENSE.txt'],
  peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta,
}, null, 2) + '\n');
await cp(resolve(root, 'docs'), resolve(dist, 'docs'), {recursive: true});
const {COMPOSITION_EXAMPLES} = await import('../lab/examples.mts');
const {serializeGraph, GRAPH_VERSION} = await import('../src/core/graph.mts');
const {serializeMarkProgram} = await import('../src/paint/marks.mts');
const {carapaceMarkProgram} = await import('../lab/mark-examples.mts');
await mkdir(resolve(dist, 'examples'), {recursive: true});
await mkdir(resolve(stage, 'examples'), {recursive: true});
for (const [name, example] of Object.entries(COMPOSITION_EXAMPLES)) {
  const text = serializeGraph(example.create());
  await writeFile(resolve(dist, 'examples', name + '.json'), text);
  await writeFile(resolve(stage, 'examples', name + '.json'), text);
}
const markProgramText = serializeMarkProgram(carapaceMarkProgram());
await writeFile(resolve(dist, 'examples', 'marks.program.json'), markProgramText);
await writeFile(resolve(stage, 'examples', 'marks.program.json'), markProgramText);
const manifest = {
  version: pkg.version, atlasLayout: 'filled-facets/11', graphVersion: GRAPH_VERSION,
  engineInjected: true, rendererBundled: false, sharedModules: true, libraries,
  atelier: {
    framework: `Solid ${pkg.devDependencies['solid-js']}`,
    effects: `Effect ${pkg.devDependencies.effect}`,
    javascriptBytes: atelierBuild.metafile.outputs['dist/lab.js'].bytes,
    cssBytes: atelierBuild.metafile.outputs['dist/lab.css']?.bytes ?? 0,
  },
};
await writeFile(resolve(dist, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(stage, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('python3', [resolve(root, 'tools/package.py'), root, stage, pkg.version], {stdio: 'inherit'});
console.log(JSON.stringify(manifest, null, 2));
