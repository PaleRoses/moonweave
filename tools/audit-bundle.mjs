import {build} from 'esbuild';
import {transformAsync} from '@babel/core';
import solidPreset from 'babel-preset-solid';
import typescriptPreset from '@babel/preset-typescript';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

// Both builds stay in memory. A receipt is written only when the current-source
// bundle matches dist/lab.js, so the reported result is the actual built artifact.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baselineArgument, reportArgument] = process.argv.slice(2);
if (!baselineArgument || !reportArgument) {
  throw new Error('Usage: node tools/audit-bundle.mjs <baseline-directory> <output-report.json>');
}
const baselineRoot = resolve(baselineArgument);
const outputReport = resolve(reportArgument);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sizes = bytes => ({javascriptBytes: bytes.length, gzipLevel9Bytes: gzipSync(bytes, {level: 9}).length, sha256: sha(bytes)});

async function bundle(directory) {
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const result = await build({
    // Match tools/build.mjs: each source tree is its own working directory,
    // and both the entry point and output path are the production relative paths.
    absWorkingDir: directory,
    entryPoints: ['lab/index.tsx'],
    outfile: 'dist/lab.js', write: false,
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'eof', metafile: true, conditions: ['browser'],
    plugins: [{name: 'solid', setup(builder) {
      builder.onLoad({filter: /\.tsx$/}, async ({path}) => {
        const compiled = await transformAsync(await readFile(path, 'utf8'), {
          filename: path, babelrc: false, configFile: false,
          presets: [[solidPreset, {generate: 'dom', hydratable: false}], [typescriptPreset, {onlyRemoveTypeImports: true}]],
        });
        if (!compiled?.code) throw new Error(`Solid compilation produced no output: ${path}`);
        return {contents: compiled.code, loader: 'js', resolveDir: dirname(path)};
      });
    }}],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).contents;
  const output = result.metafile.outputs['dist/lab.js'];
  const groups = {three: 0, effect: 0, solid: 0, core: 0, lab: 0, other: 0};
  for (const [file, input] of Object.entries(output.inputs)) {
    const group = file.includes('node_modules/three/') ? 'three'
      : file.includes('node_modules/effect/') ? 'effect'
      : file.includes('node_modules/solid-js/') ? 'solid'
      : /(?:^|\/)src\//.test(file) ? 'core'
      : /(?:^|\/)lab\//.test(file) ? 'lab' : 'other';
    groups[group] += input.bytesInOutput;
  }
  const sourceFiles = Object.keys(result.metafile.inputs).filter(file => !file.includes('node_modules/'));
  const sourceSHA256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    relative(directory, resolve(directory, file)), sha(await readFile(resolve(directory, file))),
  ])));
  return {
    version: pkg.version, ...sizes(js),
    sourceContributionsBytes: groups,
    packageLockSHA256: sha(await readFile(resolve(directory, 'package-lock.json'))),
    sourceSHA256,
  };
}

const baseline = await bundle(baselineRoot);
const current = await bundle(root);
const manifest = JSON.parse(await readFile(resolve(root, 'dist/build-manifest.json'), 'utf8'));
const built = {version: manifest.version, ...sizes(await readFile(resolve(root, 'dist/lab.js')))};
const matchesAuditedCurrent = built.version === current.version && built.sha256 === current.sha256;
if (!matchesAuditedCurrent) {
  throw new Error(`dist/lab.js or its manifest is stale. Built: ${built.version}, ${built.javascriptBytes} bytes, ${built.sha256}; current: ${current.version}, ${current.javascriptBytes} bytes, ${current.sha256}. Run the production build before issuing a bundle audit receipt.`);
}
const report = {
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: 'Baseline and current source compiled in memory with the production esbuild/Solid settings and their own project working directories; write:false. CSS excluded. No transfer-time or GPU performance claim.',
  compression: {
    format: 'gzip', level: 9, implementation: 'node:zlib', zlibVersion: process.versions.zlib,
    comparisonNote: 'Both versions use the same compressor and options. Other zlib builds can produce different gzip sizes for identical JavaScript bytes, even at the same compression level.',
  },
  baseline, current,
  savings: {
    javascriptBytes: baseline.javascriptBytes - current.javascriptBytes,
    javascriptPercent: 100 * (1 - current.javascriptBytes / baseline.javascriptBytes),
    gzipLevel9Bytes: baseline.gzipLevel9Bytes - current.gzipLevel9Bytes,
    gzipLevel9Percent: 100 * (1 - current.gzipLevel9Bytes / baseline.gzipLevel9Bytes),
  },
  dist: {...built, matchesAuditedCurrent},
};
await mkdir(dirname(outputReport), {recursive: true});
await writeFile(outputReport, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  report: relative(process.cwd(), outputReport),
  auditedBaseline: {version: baseline.version, javascriptBytes: baseline.javascriptBytes, gzipLevel9Bytes: baseline.gzipLevel9Bytes},
  auditedCurrent: {version: current.version, javascriptBytes: current.javascriptBytes, gzipLevel9Bytes: current.gzipLevel9Bytes},
  savings: report.savings, dist: report.dist, currentContributions: current.sourceContributionsBytes,
}, null, 2));
