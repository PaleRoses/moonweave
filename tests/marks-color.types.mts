import {
  toWorkingColor, convertColor, displayColor, decodeColorImage, encodeColorImage,
  markProgram, parseMarkProgram, serializeMarkProgram, compileMarkProgram, bakeMarks, applyMarkBake,
  color, image, scalar, surface,
} from '@moonweave/surfaces/core';
import type {TaggedColor, Vec3, MarkProgramInput, MarkBake, SurfaceExpression} from '@moonweave/surfaces/core';

const authored: TaggedColor<'oklch'> = {space: 'oklch', coords: [.7, .15, 240]};
const converted: TaggedColor<'display-p3'> = convertColor(authored, 'display-p3');
const output: TaggedColor<'srgb'> = displayColor(converted, 'srgb');
const pigment: Vec3 = toWorkingColor(output);
const mask = image.generate({width: 4, height: 4, channels: 1}, () => 1).resource;
const input: MarkProgramInput = {
  brushes: {tip: {mask, filter: 'anisotropic'}},
  marks: [{kind: 'stroke', brush: 'tip', color: pigment, radius: .1,
    points: [{at: [0, 0], pressure: .2}, {at: [1, 1]}], channels: {roughness: .7}}],
};
const program = parseMarkProgram(serializeMarkProgram(markProgram(input)));
const compiled = compileMarkProgram(program);
const baked: MarkBake = compiled.bake({width: 32, height: 32, samples: 4});
const other: MarkBake = bakeMarks(input, {width: 16, height: 16});
const painted: SurfaceExpression = applyMarkBake(surface.material(color.linear(pigment)), baked);
const encoded = encodeColorImage(other.pigment, 'display-p3');
const decoded = decodeColorImage(encoded, 'display-p3');
void painted; void decoded;

// @ts-expect-error output spaces require an encoded display RGB space
displayColor(authored, 'oklab');
// @ts-expect-error tag and destination generic remain correlated
const wrongSpace: TaggedColor<'srgb'> = converted;
// @ts-expect-error colors always have three coordinates
toWorkingColor({space: 'srgb', coords: [1, 0]});
// @ts-expect-error marks own immutable program arrays
program.marks.push(input.marks[0]);
// @ts-expect-error the material application requires a surface sort
applyMarkBake(scalar.constant(.5), baked);
// @ts-expect-error mark pigments are working RGB values, not a second expression algebra
markProgram({brushes: {tip: {mask}}, marks: [{kind: 'dab', brush: 'tip', transform: [1, 0, 0, 1, 0, 0], color: color.srgb('#123456')}]});
