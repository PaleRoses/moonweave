import {color, domain, materialGraph, named, scalar, surface} from '@moonweave/surfaces/core';
import type {ScalarExpression, SurfaceExpression} from '@moonweave/surfaces/core';

type Scalar = ScalarExpression | number;

/** The same field can drive pigment separately, then finish and signed height here. */
export function applyField(input: SurfaceExpression, field: ScalarExpression,
  {height, roughness}: {height: Scalar; roughness: readonly [base: Scalar, variation: Scalar]}): SurfaceExpression {
  return surface.bump(surface.channels(input, {
    roughness: scalar.add(roughness[0], scalar.multiply(roughness[1], field)),
  }), scalar.multiply(height, field));
}

export function carvedPorcelain() {
  const frame = named('porcelainSpace', domain.transform([3.4, 0, 0, 0, 0, .8, 0, 0, 0, 0, 3.4, 0, 0, 0, 0, 1]));
  const grain = named('porcelainGrain', scalar.noise({seed: 73, domain: frame}));
  const carving = named('porcelainCarving', scalar.ramp(grain, .4, .68));
  const pigment = named('porcelainPalette', color.ramp(carving, [
    [0, named('porcelainIvory', color.srgb('#eee5cf'))],
    [.35, named('porcelainMist', color.srgb('#cbd4c8'))],
    [.72, named('porcelainGlaze', color.srgb('#7b9caa'))],
    [1, named('porcelainInk', color.srgb('#40596d'))],
  ], {space: 'oklab', interpolation: 'smoothstep'}));
  const body = named('porcelainMaterial', surface.material(pigment));
  return materialGraph(named('porcelainSurface', applyField(body, carving, {
    height: named('porcelainDepth', scalar.parameter(-.035)),
    roughness: [named('porcelainPolish', scalar.parameter(.28)), named('porcelainRoughness', scalar.parameter(.28))],
  })));
}

export function weatheredShell() {
  const frame = named('weatherSpace', domain.transform([3.2, 0, 0, 0, 0, 1.4, 0, 0, 0, 0, 3.2, 0, 0, 0, 0, 1]));
  const grain = named('weatherGrain', scalar.noise({seed: 29, domain: frame}));
  const patina = named('weatherPatina', scalar.ramp(grain, .32, .76));
  const pigment = named('weatherPalette', color.ramp(patina, [
    [0, named('weatherBlue', color.srgb('#354c67'))],
    [.4, named('weatherTeal', color.srgb('#68979e'))],
    [.75, named('weatherPearl', color.srgb('#b6c8bf'))],
    [1, named('weatherIvory', color.srgb('#e3d7b8'))],
  ], {space: 'oklab', interpolation: 'smoothstep'}));
  const paint = named('weatherPaint', surface.paint('carapace', {palette: {base: pigment}}));
  return materialGraph(named('weatherSurface', applyField(paint, patina, {
    height: named('weatherDepth', scalar.parameter(.025)),
    roughness: [named('weatherPolish', scalar.parameter(.36)), named('weatherRoughness', scalar.parameter(.24))],
  })));
}
