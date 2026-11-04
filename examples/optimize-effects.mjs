/** Run with MOONWEAVE_EGGLOG_PYTHON=.venv-egglog/bin/python node examples/optimize-effects.mjs. */
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {color, image, materialGraph, named, scalar, serializeGraph, surface} from '../src/core.mjs';
import {optimizeGraph} from '../tools/optimize-graph.mjs';

/** A reusable local finish module, two layered consumers, and a creature-level finish. */
export function createFinishStudy({retainSharedConsumer = false} = {}) {
  const atlas = named('finishAtlas', image.generate({width: 16, height: 8, channels: 1},
    (u, v) => .5 + .4 * Math.sin(12 * u) * Math.cos(9 * v)));
  const oldFinish = named('moduleFinish', scalar.image(atlas, {filter: 'anisotropic'}));
  const base = named('substrate', surface.material(color.srgb('#294e62')));
  const module = named('localModule', surface.channels(base, {roughness: oldFinish}));
  const ink = named('pigment', color.srgb('#c6bba6'));
  const coverage = named('coverage', scalar.parameter(.4));
  const depth = named('depth', scalar.parameter(.004));
  const height = scalar.multiply(depth, scalar.noise({seed: 17}));
  const left = surface.coat(module, ink, coverage);
  const right = surface.bump(module, height);
  const weight = named('branchWeight', scalar.parameter(.35));
  const nested = surface.mix(left, surface.mix(right, module, weight), weight);
  const finish = named('creatureFinish', scalar.parameter(.3));
  const completed = surface.channels(nested, {roughness: finish});
  return materialGraph(retainSharedConsumer ? surface.mix(completed, module, weight) : completed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'validation/optimization-example');
  const authored = createFinishStudy();
  const {result, candidate} = optimizeGraph(authored);
  await mkdir(directory, {recursive: true});
  await Promise.all([
    writeFile(resolve(directory, 'authored.json'), serializeGraph(authored)),
    writeFile(resolve(directory, 'optimized.json'), serializeGraph(result.graph)),
    writeFile(resolve(directory, 'receipt.json'), JSON.stringify({
      accepted: result.accepted, reason: result.reason, proof: result.proof,
      before: result.before, after: result.after, engine: candidate.receipt,
    }, null, 2) + '\n'),
  ]);
  console.log(JSON.stringify({directory, accepted: result.accepted, reason: result.reason,
    before: result.before, after: result.after}, null, 2));
}
