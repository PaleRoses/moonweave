import {color, domain, mask, materialGraph, named, scalar, surface} from '@moonweave/surfaces/core';
import type {ColorExpression, ScalarExpression, SurfacePatch, Vec3} from '@moonweave/surfaces/core';

/** Color relatives retain a shared source and independently editable adjustments. */
function relative(id: string, input: ColorExpression, [lightness, chroma, hue]: Vec3): ColorExpression {
  return named(id, color.adjust(input, {
    lightness: named(`${id}Lightness`, scalar.parameter(lightness)),
    chroma: named(`${id}Chroma`, scalar.parameter(chroma)),
    hue: named(`${id}Hue`, scalar.parameter(hue)),
  }));
}

/** Pull object coordinates into an oriented mark; sizes are half extents. */
function placedMark(id: string, center: Vec3, size: Vec3, angle: number, feather: Vec3): ScalarExpression {
  const radians = angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const [x, y, z] = center, [width, length, depth] = size;
  const frame = named(`${id}Space`, domain.transform([
    c / width, -s / length, 0, 0,
    s / width, c / length, 0, 0,
    0, 0, 1 / depth, 0,
    -(c * x + s * y) / width, (s * x - c * y) / length, -z / depth, 1,
  ]));
  return named(id, mask.chisel({domain: frame, feather}));
}

function painted(id: string, pigment: ColorExpression, recipe: SurfacePatch) {
  return materialGraph(named(`${id}Surface`, surface.paint(recipe, {palette: {
    base: pigment,
    shadow: relative(`${id}Shadow`, pigment, [-.15, .88, 8]),
    light: relative(`${id}Light`, pigment, [.12, .62, -8]),
  }})));
}

/** Quiet ivory, grouped ink planes and two restrained amber gestures. */
export function inkIvory() {
  const source = named('ivoryPigment', color.oklch([.64, .04, 245]));
  const ground = relative('ivoryGround', source, [.2, .4, -155]);
  const ink = relative('ivoryInk', source, [-.28, 1, 8]);
  const amber = relative('ivoryAmber', source, [.1, 2.4, -173]);
  const inkStrength = named('ivoryInkStrength', scalar.parameter(.88));
  const amberStrength = named('ivoryAmberStrength', scalar.parameter(.82));
  const sweep = placedMark('ivorySweep', [-.25, -.1, 0], [.34, 1.25, 2.2], -24, [.09, .24, .2]);
  const echo = placedMark('ivoryEcho', [.49, .78, 0], [.22, .5, 2.2], -24, [.22, .22, .2]);
  const gesture = placedMark('ivoryGesture', [-.45, .53, 0], [.105, .5, 2.2], -24, [.1, .26, .2]);
  const fleck = placedMark('ivoryFleck', [.35, -.75, 0], [.11, .22, 2.2], 36, [.09, .28, .2]);
  const first = color.mix(ground, ink, scalar.multiply(sweep, inkStrength), {space: 'oklab'});
  const planes = color.mix(first, ink, scalar.multiply(echo, inkStrength), {space: 'oklab'});
  const stroke = color.mix(planes, amber, scalar.multiply(gesture, amberStrength), {space: 'oklab'});
  const pigment = named('ivoryPalette', color.mix(stroke, amber, scalar.multiply(fleck, amberStrength), {space: 'oklab'}));
  // Marks alter pigment. Relief and finish remain independently authored paint.
  return painted('ivory', pigment, {
    mapping: {scale: .18, stretch: [.95, 1.28, 1], rotation: -18, seed: 4817,},
    style: {
    contrast: .43, wash: .3, marks: .28, quiet: .86,
    relief: .1, roughness: .76, roughnessVariation: .05, metalness: 0, clearcoat: .02,
    },
  });
}

/** Broad verdigris deposits and one exposed brass scrape, without noisy bump. */
export function patinatedBrass() {
  const source = named('brassPigment', color.oklch([.66, .074, 86]));
  const patina = relative('brassPatina', source, [-.15, .72, 94]);
  const deep = relative('brassDeepPatina', source, [-.24, 1.05, 103]);
  const scrapeColor = relative('brassScrapeColor', source, [.13, .55, -12]);
  const patinaStrength = named('brassPatinaStrength', scalar.parameter(.92));
  const scrapeStrength = named('brassScrapeStrength', scalar.parameter(.8));
  const sweep = placedMark('brassSweep', [-.48, -.2, 0], [.42, 1.05, 2.2], 18, [.1, .3, .2]);
  const shoulder = placedMark('brassShoulder', [.55, .73, 0], [.36, .68, 2.2], -24, [.3, .26, .2]);
  const seam = placedMark('brassSeam', [.13, -.85, 0], [.13, .47, 2.2], 12, [.09, .3, .2]);
  const scrape = placedMark('brassScrape', [-.58, -.57, 0], [.1, .38, 2.2], -50, [.08, .26, .2]);
  const first = color.mix(source, patina, scalar.multiply(sweep, patinaStrength), {space: 'oklab'});
  const deposits = color.mix(first, patina, scalar.multiply(shoulder, patinaStrength), {space: 'oklab'});
  const weathered = color.mix(deposits, deep, scalar.multiply(seam, patinaStrength), {space: 'oklab'});
  const pigment = named('brassPalette', color.mix(weathered, scrapeColor, scalar.multiply(scrape, scrapeStrength), {space: 'oklab'}));
  return painted('brass', pigment, {
    mapping: {scale: .22, stretch: [1, 1.4, 1], rotation: 16, seed: 33907,},
    style: {
    contrast: .5, wash: .29, marks: .33, quiet: .84,
    relief: .1, roughness: .55, roughnessVariation: .05, metalness: .3, clearcoat: .03,
    },
  });
}
