import {evidencePath} from './evidence-path.mjs';
/** Compare persisted representations using each checkout's real session codec. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
if (!process.argv[2]) throw new Error('Usage: node --conditions=browser tools/measure-session.mjs <v60-baseline-directory> [receipt.json]');
const sha = value => createHash('sha256').update(value).digest('hex');
const moduleAt = (directory, path) => import(pathToFileURL(resolve(directory, path)).href);

async function load(directory) {
  const [core, session, examples, pkg] = await Promise.all([
    moduleAt(directory, 'src/core.mjs'), moduleAt(directory, 'lab/session.mts'),
    moduleAt(directory, 'lab/examples.mts'), readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const sourceSHA256 = {};
  for (const folder of ['src', 'lab']) for (const path of (await readdir(resolve(directory, folder), {recursive: true})).sort()) {
    if (!/\.(mjs|mts|ts|tsx)$/.test(path) || /\.d\.(mts|ts)$/.test(path)) continue;
    sourceSHA256[`${folder}/${path}`] = sha(await readFile(resolve(directory, folder, path)));
  }
  return {core, session, examples, metadata: {version: pkg.version,
    headCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: directory, encoding: 'utf8'}).trim(), sourceSHA256}};
}

const snapshot = graph => ({graph, baseline: graph,
  selectedPaint: graph.nodes.find(node => node.kind === 'paint')?.id ?? null,
  selectedBlend: null, tab: 'paint', sourceDraft: null, sourceOpen: false});

function sharing(session) {
  const current = new Map(session.graph.nodes.map(node => [node.id, node]));
  let nodes = 0, imageNodes = 0, imageResources = 0, imageSampleArrays = 0;
  for (const node of session.baseline.nodes) {
    const next = current.get(node.id);
    if (next === node) nodes++;
    if (node.kind === 'image' && next?.kind === 'image') {
      if (next === node) imageNodes++;
      if (next.resource === node.resource) imageResources++;
      if (next.resource.data === node.resource.data) imageSampleArrays++;
    }
  }
  return {nodes, imageNodes, imageResources, imageSampleArrays};
}

function measure(implementation, document, patchedBaseline) {
  const {materialGraph, patchGraph} = implementation.core, {encodeSession, decodeSession} = implementation.session;
  let baseline = materialGraph(JSON.parse(document));
  if (patchedBaseline) {
    const image = baseline.nodes.find(node => node.kind === 'image');
    baseline = patchGraph(baseline, {[image.id]: {resource: {...image.resource, data: image.resource.data.map(value => value * .5)}}});
  }
  const unedited = snapshot(baseline), paint = unedited.selectedPaint;
  const edited = {...unedited, graph: patchGraph(baseline, {[paint]: {style: {roughness: .4}}})};
  const original = encodeSession(unedited), source = encodeSession(edited), restored = decodeSession(source);
  assert.deepEqual(restored, edited);
  const reencoded = encodeSession(restored);
  assert.deepEqual(decodeSession(reencoded), edited);
  return {uneditedBytes: Buffer.byteLength(original), editedBytes: Buffer.byteLength(source),
    reencodedBytes: Buffer.byteLength(reencoded), formatVersion: JSON.parse(source).version,
    sourceSHA256: sha(source), exactValueRoundtrip: true, stableAfterReload: reencoded === source,
    beforeSaveSharing: sharing(edited), restoredSharing: sharing(restored), legacySource: source};
}

const [baseline, current] = await Promise.all([load(resolve(process.argv[2])), load(root)]);
const document = baseline.core.serializeGraph(baseline.examples.COMPOSITION_EXAMPLES.marks.create());
const cases = {}, previousSources = [];
for (const [name, patched] of [['paintedCarapace', false], ['patchedImageBaseline', true]]) {
  const before = measure(baseline, document, patched), after = measure(current, document, patched);
  previousSources.push({name, source: before.legacySource});
  delete before.legacySource; delete after.legacySource;
  const savedBytes = before.editedBytes - after.editedBytes;
  cases[name] = {baseline: before, current: after, savedBytes, savedFraction: savedBytes / before.editedBytes};
}

// Old autosaves still restore into the live editor; new undo keeps that exact document.
const [{createRoot}, {createEditor}] = await Promise.all([import('solid-js'), moduleAt(root, 'lab/editor.ts')]);
const migrations = {};
for (const {name, source} of previousSources) {
  const restored = current.session.decodeSession(source);
  assert.deepEqual(restored, baseline.session.decodeSession(source));
  const upgraded = current.session.encodeSession(restored);
  assert.equal(sha(upgraded), cases[name].current.sourceSHA256);
  assert.deepEqual(sharing(restored), cases[name].current.restoredSharing);
  assert.equal(current.session.encodeSession(current.session.decodeSession(upgraded)), upgraded);
  migrations[name] = {previousBytes: Buffer.byteLength(source), upgradedBytes: Buffer.byteLength(upgraded),
    stableAfterReload: true, restoredSharing: sharing(restored)};
  createRoot(dispose => {
    const editor = createEditor({initial: restored, commit() {}, invalidate() {},
      frames: {request: () => 1, cancel() {}}});
    try {
      editor.queueStyle({roughness: .27});
      assert.equal(editor.gestureEnd(), true);
      assert.equal(editor.undo(), true);
      assert.equal(editor.graph(), restored.graph);
      assert.equal(editor.reset(), true);
      assert.equal(editor.graph(), restored.baseline);
      assert.equal(editor.undo(), true);
      assert.equal(editor.graph(), restored.graph);
    } finally {editor.dispose(); dispose();}
  });
}

const result = {
  version: current.metadata.version,
  environment: {node: process.version, platform: process.platform, architecture: process.arch},
  method: 'Both checkouts import the same v0.60 Painted carapace JSON, patch roughness to 0.4, encode/decode with their own codec, then encode again. A second case first patches one image resource. Sizes are UTF-8 bytes; this measures representation and identity, not timing or browser storage quota.',
  benchmarkSHA256: sha(await readFile(script)), graphSHA256: sha(document),
  baseline: baseline.metadata, current: current.metadata, cases,
  migratedVersionOne: {checkedSessions: previousSources.length, exactValuesAndBaselines: true, newEditUndoAndResetUndo: true,
    compactAfterUpgrade: true, cases: migrations},
  identityScope: 'Version 2 references unchanged node objects across the current graph and reset baseline; replaced nodes and separately authored resources remain distinct even when values match. Version 1 migration compares normalized same-ID records once and borrows exact matches from the baseline. Different IDs are never merged.',
};
const output = resolve(process.argv[3] ?? evidencePath('session.json'));
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, cases, migratedVersionOne: result.migratedVersionOne}, null, 2));
