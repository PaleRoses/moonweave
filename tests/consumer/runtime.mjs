import assert from 'node:assert/strict';
import * as core from '@moonweave/surfaces/core';
import * as combined from '@moonweave/surfaces';
import * as adapter from '@moonweave/surfaces/three';
import * as optimizer from '@moonweave/surfaces/optimize';

assert.equal(combined.materialGraph, core.materialGraph, 'public entries share the core module');
assert.equal(combined.SURFACE_SIGNATURE, core.SURFACE_SIGNATURE);
assert.equal(combined.createTexturingSystem, adapter.createTexturingSystem);
assert.equal(combined.color, core.color);
assert.equal(combined.evaluateColor, core.evaluateColor);
assert.equal(combined.expressionGraph, core.expressionGraph);
assert.equal(combined.graphExpression, core.graphExpression);
assert.equal(combined.createFieldSampler, core.createFieldSampler);
assert.equal(combined.mask, core.mask);
assert.equal(combined.inspectGraph, core.inspectGraph);

const field = core.named('field', core.facets());
const strength = core.named('strength', core.scalar.parameter(.7));
const graph = core.materialGraph(core.surface.channels(core.surface.paint(field), {roughness: strength}));
const optimization = optimizer.applyOptimization(graph, optimizer.createOptimizationJob(graph));
assert.equal(optimization.graph, graph, 'optimization entry shares owned graph identity');
assert.equal(optimization.reason, 'no-improvement');
assert.equal(optimization.proof.equivalent, true);
assert.equal(combined.materialGraph(graph), graph);
assert.equal(core.evaluateScalar(graph, 'strength').value, .7);
const next = combined.patchGraph(graph, {strength: {value: .4}});
assert.equal(core.evaluateScalar(next, 'strength').value, .4);
assert.equal(core.compileGraph(next).structure, combined.compileGraph(graph).structure,
  'package entry boundaries preserve compiled topology identity');
assert.equal(core.inspectGraph(next),combined.inspectGraph(graph),'inspection follows shared topology across entries and edits');
assert.equal(core.inspectGraph(graph).nodes[core.inspectGraph(graph).output].id,core.compileGraph(graph).output);
assert.equal(core.patchGraph(next, {strength: {value: .4}}), next);
assert.deepEqual(core.parseGraph(core.serializeGraph(next)), next);

const grain = core.named('grain', core.scalar.noise({seed: 0xffffffff}));
const pigment = core.named('pigment', core.color.mix(
  core.named('dark', core.color.srgb('#284d58')),
  core.color.linear([.6, .8, .9]), grain,
));
const procedural = core.materialGraph(core.surface.channels(core.surface.material(pigment), {roughness: grain}));
const proceduralPlan = core.compileGraph(procedural);
assert.equal(proceduralPlan.cost.proceduralSamples, 1);
assert.equal(proceduralPlan.cost.paintSamples, 0);
assert.equal(proceduralPlan.cost.textureReads, 0);
const context = {position: [.37, -.21, .68], dx: [.01, 0, 0], dy: [0, .01, 0]};
const noiseSample = core.evaluateScalar(procedural, 'grain', context);
assert(noiseSample.value >= 0 && noiseSample.value <= 1);
const colorSample = core.evaluateColor(procedural, 'pigment', context);
for (const key of ['value', 'dx', 'dy']) {
  assert.equal(colorSample[key].length, 3);
  assert(colorSample[key].every(Number.isFinite));
  assert(Object.isFrozen(colorSample[key]));
}
assert(Object.isFrozen(colorSample));
const revised = combined.patchGraph(procedural, {grain: {seed: 41}, dark: {value: [.1, .2, .3]}});
assert.equal(core.compileGraph(revised).structure, proceduralPlan.structure);
assert.deepEqual(core.evaluateColor(revised, 'dark').value, [.1, .2, .3]);
assert.deepEqual(core.evaluateColor(core.parseGraph(core.serializeGraph(revised)), 'pigment', context),
  core.evaluateColor(revised, 'pigment', context));

const ramp = core.named('ramp', core.color.ramp(grain, [
  [0, core.color.linear([-.1, .2, .3])], [.5, pigment], [1, core.color.srgb('#e1cba1')],
], {space: 'oklab', interpolation: 'smoothstep'}));
const painted = core.materialGraph(core.surface.paint('carapace', {palette: {base: ramp, shadow: pigment}}));
assert.deepEqual(core.PALETTE_KEYS, ['base', 'shadow', 'light']);
assert.equal(core.compileGraph(painted).cost.paintSamples, 1);
assert.equal(core.compileGraph(painted).cost.proceduralSamples, 1);
const resampled = core.patchGraph(painted, {ramp: {positions: [-.5, .25, 1.5]}});
assert.equal(core.compileGraph(resampled).structure, core.compileGraph(painted).structure);
const rampSample = core.evaluateColor(resampled, 'ramp', context);
assert(rampSample.value.every(Number.isFinite));
assert(rampSample.dx.every(Number.isFinite));
assert.deepEqual(core.evaluateColor(core.parseGraph(core.serializeGraph(resampled)), 'ramp', context), rampSample);

const fieldGraph = core.expressionGraph(grain), fieldSample = core.createFieldSampler(fieldGraph);
assert.deepEqual(fieldSample(context), noiseSample);
assert.deepEqual(core.parseExpressionGraph(core.serializeGraph(fieldGraph)), fieldGraph);
const otherField = core.patchGraph(fieldGraph, {grain: {seed: 41}});
assert.notDeepEqual(core.createFieldSampler(otherField)(context), fieldSample(context));
const template = core.named('skin', core.surface.bump(core.surface.paint('carapace'), core.scalar.multiply(grain, .05)));
const firstInstance = core.instantiate(template, {prefix: 'left', shared: [grain]});
const secondInstance = core.instantiate(template, {prefix: 'right', shared: [grain]});
const instanced = core.materialGraph(core.surface.mix(firstInstance, secondInstance, .5));
assert.equal(instanced.nodes.filter(node => node.id === 'grain').length, 1);
assert.equal(instanced.nodes.filter(node => node.kind === 'bump').length, 2);
assert.equal(core.compileGraph(instanced).cost.proceduralSamples, 1);
assert.throws(() => core.materialGraph(fieldGraph), /surface node/);

const restoredField = core.parseExpressionGraph(core.serializeGraph(fieldGraph));
const restoredExpression = core.graphExpression(restoredField);
assert.equal(combined.graphExpression(restoredField), restoredExpression);
assert.equal(core.graphExpression(restoredField, 'grain'), restoredExpression);
assert.equal(core.serializeGraph(restoredExpression), core.serializeGraph(restoredField));
const restoredHeight = core.instantiate(restoredExpression, {prefix: 'restored'});
const reused = core.materialGraph(core.surface.bump(core.surface.material(
  core.graphExpression(core.expressionGraph(core.color.srgb('#203040'))),
), core.scalar.multiply(restoredHeight, .04)));
assert.equal(core.compileGraph(reused).cost.proceduralSamples, 1);
assert.deepEqual(core.evaluateScalar(reused, 'restored_grain', context), fieldSample(context));

const hue = core.named('hue', core.scalar.parameter(0));
const adjusted = core.named('adjusted', core.color.adjust(core.color.oklch([.65, .1, 225]), {lightness: .05, chroma: 1.2, hue}));
const shaped = core.named('coverage', core.mask.chisel({feather: [.1, .2, .3]}));
const paintedMark = core.materialGraph(core.surface.bump(core.surface.material(adjusted), core.scalar.multiply(shaped, .03)));
const adjustedSample = core.evaluateColor(paintedMark, 'adjusted', context);
const rotatedMark = core.patchGraph(paintedMark, {hue: {value: 90}});
assert.equal(core.compileGraph(rotatedMark).structure, core.compileGraph(paintedMark).structure);
assert.notDeepEqual(core.evaluateColor(rotatedMark, 'adjusted', context).value, adjustedSample.value);
assert.deepEqual(core.evaluateColor(core.parseGraph(core.serializeGraph(rotatedMark)), 'adjusted', context),
  core.evaluateColor(rotatedMark, 'adjusted', context));
assert.equal(core.createFieldSampler(core.mask.interval(core.scalar.axis('x'), 0, 1))({position: [.5, 0, 0]}).value, 1);
assert.equal(core.createFieldSampler(shaped)({position: [0, 0, 0]}).value, 1);
assert.equal(core.color.oklab([.5, 0, 0]).kind, 'color');

await assert.rejects(import('@moonweave/surfaces/src/core/algebra.mts'),
  {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});

assert.equal(core.image, combined.image);
assert.equal(core.pigment, combined.pigment);
assert.equal(core.applyZones, combined.applyZones);
const yellow = core.pigment.srgb('#dcc878'), blue = core.pigment.srgb('#315e79');
const spectralTable = core.named('spectralTable', core.image.generate({width: 8, height: 1, channels: 3},
  (_u, _v, x) => core.pigment.toLinear(core.pigment.mix(yellow, blue, x / 7))));
const imageColor = core.named('imageColor', core.color.image(spectralTable));
const imageMask = core.named('imageMask', core.scalar.image(spectralTable, {channel: 'g'}));
const zoned = core.materialGraph(core.applyZones(core.surface.paint('carapace'), [
  core.zone('wash', imageMask, {color: imageColor, height: .003, channels: {roughness: .7}}),
]));
const restoredZoned = core.parseGraph(core.serializeGraph(zoned));
assert.equal(zoned.nodes.filter(node => node.kind === 'image').length, 1);
assert.deepEqual(core.evaluateColor(restoredZoned, 'imageColor', context), core.evaluateColor(zoned, 'imageColor', context));
assert.equal(core.compileGraph(zoned).cost.textureReads, 8);
assert.equal(core.pigment.add(core.pigment.add(), yellow), yellow);

// The installed core owns tagged color boundaries and reusable painterly marks.
const working = core.toWorkingColor({space: 'srgb', coords: [.6, .4, .2]});
assert.deepEqual(core.convertColor({space: 'linear-rec709', coords: working}, 'linear-rec709').coords, working);
const display = core.displayColor({space: 'oklch', coords: [.7, .4, 32]}, 'display-p3');
assert(display.coords.every(component => component >= 0 && component <= 1));
const brushResource = core.image.data({width: 2, height: 2, channels: 1, data: [1, 1, 1, 1]}).resource;
const markProgram = core.markProgram({brushes: {ink: {mask: brushResource}}, marks: [
  {kind: 'dab', brush: 'ink', color: working, transform: [1, 0, 0, 1, 0, 0], height: .003, channels: {roughness: .7}},
]});
assert.deepEqual(core.parseMarkProgram(core.serializeMarkProgram(markProgram)), markProgram);
const markPlan = core.compileMarkProgram(markProgram), markBake = markPlan.bake({width: 8, height: 8});
assert.equal(markPlan.dabCount, 1);
assert.equal(markBake.stats.dabs, 1);
const marked = core.materialGraph(core.applyMarkBake(core.surface.material(core.color.linear([.2, .3, .4])), markBake));
assert(marked.nodes.some(node => node.kind === 'deposit'));
assert(marked.nodes.some(node => node.kind === 'bump'));
assert.equal(core.compileGraph(marked).cost.paintSamples, 0);
assert.deepEqual(core.parseGraph(core.serializeGraph(marked)), marked);
const sharedSamples = core.createFieldSampler(procedural, {
  grain: {id: 'grain', sort: 'scalar'}, pigment: {id: 'pigment', sort: 'color'},
})(context);
assert.deepEqual(sharedSamples.grain, noiseSample);
assert.deepEqual(sharedSamples.pigment, colorSample);
