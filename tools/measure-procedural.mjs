import {evidencePath} from './evidence-path.mjs';
/** Reproduce graph work and lazy-resource counts; this is not a frame-time benchmark. */
import * as THREE from 'three';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileGraph, color, surface} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';
import {generateSurfaceShader} from '../src/three/shader.mjs';
import {COMPOSITION_EXAMPLES} from '../lab/examples.mts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = {
  color: surface.material(color.linear([.2, .4, .6])),
  stone: COMPOSITION_EXAMPLES.stone.create(),
  lichen: COMPOSITION_EXAMPLES.lichen.create(),
  carapace: surface.paint('carapace'),
};
const examples = Object.fromEntries(Object.entries(fixtures).map(([name, graph]) => {
  const plan = compileGraph(graph), shader = generateSurfaceShader(plan);
  const system = createTexturingSystem(THREE);
  try {
    system.createMaterial(graph);
    return [name, {
      authoredNodes: plan.graph.nodes.length, liveNodes: plan.nodes.length,
      ...plan.cost,
      atlasTextureObjects: Number(system.fields.top !== null) + Number(system.fields.wall !== null),
      atlasBuilds: system.fields.stats.builds.length,
      atlasStorageBytesIncludingMipmaps: system.fields.bytes,
      generatedGLSLBytes: Buffer.byteLength(shader.declarations + shader.evaluate),
      emitsFacetKernel: shader.declarations.includes('MoonweaveField mwSample('),
      emitsNoiseKernel: shader.declarations.includes('float mwNoise('),
    }];
  } finally {system.dispose();}
}));
const report = {
  version: JSON.parse(readFileSync(resolve(root, 'package.json'))).version,
  method: 'Compile public expressions, generate the actual shader and construct real Three material handles. Count atlas objects/builds. Storage includes the declared mip levels; no GPU upload or frame-time measurement.',
  examples,
};
const output = resolve(process.argv[2] ?? evidencePath('procedural.json'));
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
