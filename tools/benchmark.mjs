import {evidencePath} from './evidence-path.mjs';
import * as THREE from 'three';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {surface, scalar, facets, splitRecipe, materialGraph, compileGraph, makePaintFields} from '../src/core.mjs';
import {createTexturingSystem} from '../src/three.mjs';

const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const time = run => { const start = performance.now(); run(); return performance.now()-start; };
const mapping = facets(splitRecipe('carapace').mapping);
const a = surface.paint(mapping, 'carapace'), b = surface.paint(mapping, 'horn');
const mask = scalar.ramp(scalar.facing([0,-1,0]), -.25, .65);
const make = amount => surface.mix(a, b, scalar.multiply(mask, scalar.parameter(amount)));
const independent = surface.mix(surface.paint('carapace'), surface.paint('horn'), scalar.parameter(.5));
const costs = {
  onePaint: compileGraph(a).cost,
  sharedTwoPaints: compileGraph(make(.5)).cost,
  independentTwoPaints: compileGraph(independent).cost,
  eliminatedSecondPaint: compileGraph(surface.mix(a, surface.paint('horn'), 0)).cost,
};

let generated;
makePaintFields();
const atlasMs = Array.from({length:5}, () => time(() => { generated = makePaintFields(); }));
const graph = materialGraph(make(.5));
const source = JSON.stringify(graph);
for (let i=0;i<50;i++) compileGraph(JSON.parse(source));
const compilationMs = Array.from({length:5}, () => time(() => {for (let i=0;i<200;i++) compileGraph(JSON.parse(source));}));
const system = createTexturingSystem(THREE), handle = system.createMaterial(graph);
const shader = {vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms:{}};
handle.material.onBeforeCompile(shader);
const identity = handle.material.uuid, version = handle.material.version;
const key = handle.material.customProgramCacheKey(), textures = system.fields.ensure();
const strength = graph.nodes.find(node => node.kind === 'parameter').id;
const containers = Object.entries(shader.uniforms).map(([name, uniform]) => [name, uniform, uniform.value]);
const updateMs = Array.from({length:5}, () => time(() => {
  for(let i=0;i<200;i++) handle.patch({[strength]: {value: i/199}});
}));
const stable = handle.material.uuid===identity && handle.material.version===version
  && handle.material.customProgramCacheKey()===key
  && textures===system.fields.ensure()
  && containers.every(([name, uniform, value]) => shader.uniforms[name]===uniform
    && (typeof value==='number' || uniform.value===value));
if (!stable) throw new Error('An edit rebuilt a material, program, texture, or uniform container.');
const result = {
  environment:{node:process.version,three:THREE.REVISION,platform:process.platform,architecture:process.arch},
  scope:'CPU wall time in this process; excludes GPU upload, driver compilation, rendering and browser animation.',
  method:'Five runs after warm-up; graph compilation and edits perform 200 operations per run. Compilation parses a fresh document each time; edits use the value-patch API.',
  atlasGenerationMedianMs:median(atlasMs),
  graphCompilationMedianMs:median(compilationMs)/200,
  graphUpdateMedianMs:median(updateMs)/200,
  materialTextureProgramAndUniformIdentityStable:stable,
  atlasBytes:system.fields.bytes,
  atlasSHA256:{top:createHash('sha256').update(generated.top).digest('hex'),wall:createHash('sha256').update(generated.wall).digest('hex')},
  costs,
};
system.dispose();
await writeFile(process.argv[2] ?? evidencePath('benchmark.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
