/** Paired authoring measurements; counters run separately from timed code. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {cpus} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const rounds = 7, warmup = 1000, iterations = 5000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let observed;

async function fixture(directory) {
  const core = await import(pathToFileURL(resolve(directory, 'src/core.mjs')).href);
  const {normalizePaintStyle, normalizeSurfaceRecipe, patchSurfaceRecipe, facets, surface, materialGraph, patchGraph, color} = core;
  const canonical = core.SURFACE_RECIPE_VERSION >= 2;
  const recipePatch = style => canonical ? {style} : style;
  const paletteOf = paint => canonical ? paint.palette : paint.style.palette;
  const field = facets(), style = normalizePaintStyle({roughness: .6});
  const recipe = normalizeSurfaceRecipe(recipePatch({roughness: .6}));
  const graph = materialGraph(surface.paint(field, style));
  const paint = graph.nodes.find(node => node.kind === 'paint');
  const colors = ['#123456', '#abcdef'], linear = canonical ? colors.map(hex => color.srgb(hex).value) : [];
  const amount = i => ((i % 997) + 1) / 1000;
  const patch = style => patchGraph(graph, {[paint.id]: {style}});
  return {core, canonical, recipePatch, paletteOf, field, style, recipe, graph, paint, operations: {
    constructTrustedStyle: () => surface.paint(field, style),
    constructAndNormalizeTrustedStyle: () => materialGraph(surface.paint(field, style)),
    constructAndNormalizeRawStyle: i => materialGraph(surface.paint(field, {roughness: amount(i)})),
    constructAndNormalizePreset: () => materialGraph(surface.paint('horn')),
    roughnessPatch: i => patch({roughness: amount(i)}),
    oneColorPatch: i => canonical ? patchGraph(graph, {[paint.palette.base]: {value: linear[i % 2]}})
      : patch({palette: {base: colors[i % 2]}}),
    sameRoughnessPatch: () => patch({roughness: style.roughness}),
    emptyStylePatch: () => patch({}),
    sameNormalizedStylePatch: () => patch(paint.style),
    recipeRoughnessPatch: i => patchSurfaceRecipe(recipe, recipePatch({roughness: amount(i)})),
  }};
}

function identities({core, canonical, recipePatch, paletteOf, field, style, recipe, graph, paint}) {
  const {surface, materialGraph, patchGraph, patchSurfaceRecipe, splitRecipe, normalizePaintStyle, normalizeSurfaceRecipe} = core;
  const count = 1000;
  const expressions = Array.from({length: count}, () => surface.paint(field, style));
  const graphPaints = expressions.map(expression => materialGraph(expression).nodes.find(node => node.kind === 'paint'));
  const revisions = Array.from({length: count}, (_, i) => patchGraph(graph, {[paint.id]: {style: {roughness: (i + .5) / count}}}));
  const revisionPaints = revisions.map(value => value.nodes.find(node => node.id === paint.id));
  const editedRecipe = patchSurfaceRecipe(recipe, recipePatch({roughness: .2}));
  const raw = canonical ? {style: {roughness: .4}, palette: {base: {kind: 'color', value: [.1, .2, .3]}}}
    : {palette: {base: '#abcdef'}, roughness: .4};
  const owned = canonical ? normalizeSurfaceRecipe(raw) : normalizePaintStyle(raw);
  if (canonical) {
    raw.palette.base.value[0] = .9; raw.style.roughness = .9;
    assert.deepEqual(owned.palette.base.value, [.1, .2, .3]);
    assert.equal(owned.style.roughness, .4);
  } else {
    raw.palette.base = '#000000'; raw.roughness = .9;
    assert.equal(owned.palette.base, '#abcdef');
    assert.equal(owned.roughness, .4);
  }
  return {
    representation: canonical ? 'graph-v2 color-reference palettes' : 'graph-v1 style swatches',
    retainedExamples: count, trustedInputStyles: 1,
    expressionStyles: new Set(expressions.map(value => value.style)).size,
    expressionPaletteRecords: new Set(expressions.map(paletteOf)).size,
    graphStyles: new Set(graphPaints.map(value => value.style)).size,
    graphPaletteRecords: new Set(graphPaints.map(paletteOf)).size,
    roughnessRevisionStyles: new Set(revisionPaints.map(value => value.style)).size,
    roughnessRevisionPaletteRecords: new Set(revisionPaints.map(paletteOf)).size,
    expressionRetainsTrustedStyle: expressions[0].style === style,
    graphRetainsTrustedStyle: graphPaints[0].style === style,
    roughnessRevisionRetainsPalette: paletteOf(revisionPaints[0]) === paletteOf(paint),
    recipeRoughnessRetainsMapping: splitRecipe(editedRecipe).mapping === splitRecipe(recipe).mapping,
    recipeRoughnessRetainsPalette: editedRecipe.palette === recipe.palette,
    sameRecipePatchRetainsIdentity: patchSurfaceRecipe(recipe, recipePatch({roughness: splitRecipe(recipe).style.roughness})) === recipe,
    callerDataDetachedAndMutable: !Object.isFrozen(raw) && !Object.isFrozen(raw.palette),
    normalizedStyleAndPaletteFrozen: Object.isFrozen(canonical ? owned.style : owned) && Object.isFrozen(owned.palette),
  };
}

async function workCounts(directory) {
  const counters = ['mappingValidations', 'styleValidations', 'numericChecks', 'styleNumericChecks',
    'colorChecks', 'snapshotCopies', 'snapshotStyleCopies', 'snapshotPaletteCopies'];
  let counts = Object.fromEntries(counters.map(key => [key, 0]));
  globalThis.__moonweaveValueAudit = key => { counts[key]++; };
  const moduleURL = (...candidates) => {
    const file=candidates.find(path=>existsSync(resolve(directory,path)));
    assert(file, `Missing measured source: ${candidates.join(', ')}`);
    return pathToFileURL(resolve(directory,file)).href;
  };
  const canonical = existsSync(resolve(directory, 'src/core/ownership.mts'));
  const recipeURL = moduleURL('src/core/recipe.mts', 'src/core/recipe.mjs', 'src/texturing-recipe.mjs');
  const dataURL = moduleURL('src/core/ownership.mts', 'src/core/graph.mts', 'src/core/graph.mjs', 'src/surface-graph-data.mjs');
  const algebraURL = canonical ? moduleURL('src/core/algebra.mts') : undefined;
  function inject(source, pattern, addition) {
    const matches = [...source.matchAll(pattern)];
    assert.equal(matches.length, 1, `Counter instrumentation needs one matching source anchor: ${pattern}`);
    const end = matches[0].index + matches[0][0].length;
    return source.slice(0, end) + addition + source.slice(end);
  }
  const hook = registerHooks({load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === recipeURL) {
      let source = String(loaded.source);
      source = inject(source, /function number\([^)]*\)(?:: number)?\s*\{/g,
        ` globalThis.__moonweaveValueAudit('numericChecks'); if(${canonical ? 'STYLE_KEYS' : 'unitFields'}.includes(name))globalThis.__moonweaveValueAudit('styleNumericChecks');`);
      source = inject(source, /record\(input, 'facet mapping', (?:FACET_KEYS|mappingKeys)\);/g,
        " globalThis.__moonweaveValueAudit('mappingValidations');");
      source = inject(source, /record\(input, 'paint style', (?:STYLE_KEYS|styleKeys)\);/g,
        " globalThis.__moonweaveValueAudit('styleValidations');");
      const colorPattern = canonical ? /const value = palette\[key\];/g
        : source.includes('function color(value, name) {') ? /function color\(value, name\) \{/g
          : /const color = value.palette\[key\];/g;
      source = inject(source, colorPattern,
        " globalThis.__moonweaveValueAudit('colorChecks');");
      loaded.source = source;
    } else if (url === dataURL) {
      loaded.source = inject(String(loaded.source),
        /const copy\s*=\s*\(?Array\.isArray\(value\)\s*\?\s*(?:\[\]|new Array\(value\.length\))\s*:\s*\{\}\)?(?: as Record<string, unknown>)?;/g,
        " globalThis.__moonweaveValueAudit('snapshotCopies'); if(typeof value.roughness==='number'&&typeof value.contrast==='number')globalThis.__moonweaveValueAudit('snapshotStyleCopies'); if(Object.hasOwn(value,'base'))globalThis.__moonweaveValueAudit('snapshotPaletteCopies');");
    } else if (url === algebraURL) {
      loaded.source = inject(String(loaded.source), /function linearColor\(value: unknown\): Vec3 \{/g,
        " globalThis.__moonweaveValueAudit('colorChecks');");
    }
    return loaded;
  }});
  try {
    const {operations} = await fixture(directory), results = {};
    for (const [name, operation] of Object.entries(operations)) {
      counts = Object.fromEntries(counters.map(key => [key, 0]));
      observed = operation(21);
      results[name] = counts;
    }
    return results;
  } finally {
    hook.deregister();
    delete globalThis.__moonweaveValueAudit;
  }
}

async function fingerprint(directory) {
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const files = (await readdir(resolve(directory, 'src'), {recursive: true}))
    .filter(name => /\.(mjs|mts)$/.test(name) && !name.endsWith('.d.mts')).sort();
  const sourceSHA256 = Object.fromEntries(await Promise.all(files.map(async name => [
    `src/${name}`, sha(await readFile(resolve(directory, 'src', name))),
  ])));
  return {version: pkg.version, sourceSHA256};
}

async function main() {
  const [baselineArgument, reportArgument] = process.argv.slice(2);
  if (!baselineArgument || !reportArgument) throw new Error('Usage: node --expose-gc tools/benchmark-values.mjs <baseline-directory> <output-report.json>');
  const directories = {baseline: resolve(baselineArgument), current: root};
  const fixtures = {}, results = {};
  for (const [label, directory] of Object.entries(directories)) {
    fixtures[label] = await fixture(directory);
    results[label] = {...await fingerprint(directory), metrics: {}};
  }
  const names = Object.keys(fixtures.current.operations);
  assert.deepEqual(Object.keys(fixtures.baseline.operations), names);
  for (const label of ['baseline', 'current']) for (const name of names) {
    for (let i = 0; i < warmup; i++) observed = fixtures[label].operations[name](i);
    results[label].metrics[name] = {samplesMicroseconds: []};
  }
  const order = Array.from({length: rounds}, (_, round) => round % 2 ? ['current', 'baseline'] : ['baseline', 'current']);
  for (const labels of order) for (const name of names) for (const label of labels) {
    globalThis.gc?.();
    const operation = fixtures[label].operations[name], start = performance.now();
    for (let i = 0; i < iterations; i++) observed = operation(i);
    results[label].metrics[name].samplesMicroseconds.push((performance.now() - start) * 1000 / iterations);
  }
  for (const label of ['baseline', 'current']) {
    for (const metric of Object.values(results[label].metrics)) {
      metric.medianMicroseconds = [...metric.samplesMicroseconds].sort((a, b) => a - b)[Math.floor(rounds / 2)];
    }
    results[label].identity = identities(fixtures[label]);
    results[label].workCounts = JSON.parse(execFileSync(process.execPath, [script, '--work-counts', directories[label]], {encoding: 'utf8'}));
  }
  const comparison = Object.fromEntries(names.map(name => {
    const baseline = results.baseline.metrics[name].medianMicroseconds, current = results.current.metrics[name].medianMicroseconds;
    return [name, {baselineMicroseconds: baseline, currentMicroseconds: current, speedup: baseline / current}];
  }));
  const report = {
    environment: {node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model},
    method: {rounds, iterationsPerRound: iterations, warmupPerOperation: warmup, order, explicitGCBeforeBatch: !!globalThis.gc,
      timing: 'Uninstrumented implementations in one process; alternating baseline/current order in each paired round. Patches branch from the same immutable base.',
      workCounts: 'Separate subprocesses instrument decoder checks and constructor snapshots in memory. Counts exclude import and fixture setup; one operation per scenario. Source anchors fail closed if implementation layout changes.',
      identity: 'Distinct retained object identities across 1000 examples; not a heap-byte estimate. Canonical graph palette records contain node references, while v1 style palettes contain swatches; their record counts describe different representations.',
      colorEdits: 'Patch inputs are already in each API representation: canonical linear RGB node values or legacy sRGB style swatches. Fixture color decoding is excluded from patch timing.',
      scope: 'Synchronous CPU authoring only. No Three.js, atlas generation, rendering, DOM work or GPU/transfer-time claim.'},
    benchmarkSHA256: sha(await readFile(script)), ...results, comparison,
  };
  const output = resolve(reportArgument);
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({report: output, comparison, identity: {baseline: results.baseline.identity, current: results.current.identity}}, null, 2));
}

if (process.argv[2] === '--work-counts') console.log(JSON.stringify(await workCounts(resolve(process.argv[3]))));
else await main();
void observed;
