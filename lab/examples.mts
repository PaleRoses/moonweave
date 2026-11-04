import {color, domain, materialGraph, named, scalar, surface} from '@moonweave/surfaces/core';
import type {MaterialGraph} from '@moonweave/surfaces/core';
import {composeSurface} from './composition.mts';
import {carvedPorcelain, weatheredShell} from './surface-examples.mts';
import {inkIvory, patinatedBrass} from './painterly-examples.mts';
import {paintedCarapace} from './mark-examples.mts';
import {zonedEnamel, spectralPatina, inscribedGlaze} from './application-examples.mts';

/** Gallery factories are ordinary graph programs, separate from editor commands. */
export const COMPOSITION_EXAMPLES = Object.freeze({
  belly: {
    label: 'Pale underside',
    create: () => composeSurface({
      base: 'carapace', accent: 'horn', mode: 'facing', axis: 'y',
      center: -.1, width: .8, invert: true, amount: .94, shared: true,
    }),
  },
  tips: {
    label: 'Darkened tips',
    create: () => composeSurface({
      base: 'horn', accent: 'obsidian', mode: 'height', axis: 'y',
      center: .65, width: 1.0, invert: false, amount: .94, shared: false,
    }),
  },
  patina: {
    label: 'Two pigments',
    create: () => composeSurface({
      base: 'moonstone', accent: 'velvet', mode: 'uniform', amount: .45, shared: true,
    }),
  },
  finish: {
    label: 'Directional finish',
    create() {
      const roughness = named('roughnessRamp', scalar.ramp(
        named('finishDirection', scalar.facing([0, 1, 0])), -.6, .8,
      ));
      const painted = named('carapacePaint', surface.paint('carapace'));
      const relief = surface.relief(painted, named('reliefGain', scalar.parameter(.7)));
      return materialGraph(surface.channels(relief, {
        roughness, metalness: named('metalness', scalar.parameter(.15)),
      }));
    },
  },
  stone: {
    label: 'Procedural stone',
    create() {
      const frame = named('stoneSpace', domain.transform([
        3.2, 0, 0, 0,
        0, 3.2, 0, 0,
        0, 0, 3.2, 0,
        0, 0, 0, 1,
      ]));
      const grain = named('stoneGrain', scalar.noise({seed: 37, domain: frame}));
      const tone = named('stoneTone', scalar.ramp(grain, .28, .72));
      const pigment = color.mix(
        named('stoneShadow', color.srgb('#484653')),
        named('stoneLight', color.srgb('#c5bbc4')),
        tone,
      );
      const body = named('stoneMaterial', surface.material(pigment));
      const roughness = scalar.add(
        named('stonePolish', scalar.parameter(.32)),
        scalar.multiply(named('stoneGrainRoughness', scalar.parameter(.42)), grain),
      );
      return materialGraph(named('stoneSurface', surface.channels(body, {roughness})));
    },
  },
  lichen: {
    label: 'Lichen on shell',
    create() {
      const frame = named('lichenSpace', domain.transform([
        2.6, 0, 0, 0,
        0, 2.6, 0, 0,
        0, 0, 2.6, 0,
        0, 0, 0, 1,
      ]));
      const growth = named('lichenNoise', scalar.noise({seed: 21, domain: frame}));
      const coverage = named('lichenCoverage', scalar.ramp(growth, .49, .68));
      const pigment = color.mix(
        named('lichenShade', color.srgb('#244940')),
        named('lichenLight', color.srgb('#c9d493')),
        growth,
      );
      const lichen = surface.channels(named('lichenMaterial', surface.material(pigment)), {
        roughness: named('lichenRoughness', scalar.parameter(.89)),
      });
      return materialGraph(named('lichenShell', surface.mix(
        named('shellPaint', surface.paint('carapace')), lichen, coverage,
      )));
    },
  },
  spectrum: {
    label: 'Color bands',
    create() {
      const frame = named('bandSpace', domain.transform([
        1, 0, 0, 0,
        0, .5, 0, 0,
        0, 0, 1, 0,
        0, .5, 0, 1,
      ]));
      const height = named('bandHeight', scalar.axis('y', frame));
      const pigment = named('bandPalette', color.ramp(height, [
        [0, named('deepIndigo', color.srgb('#26344e'))],
        [.35, named('seaGlass', color.srgb('#6cafa8'))],
        [.67, named('warmIvory', color.srgb('#e3dcc0'))],
        [1, named('dustRose', color.srgb('#956d87'))],
      ], {space: 'oklab', interpolation: 'smoothstep'}));
      return materialGraph(named('bandSurface', surface.channels(
        surface.material(pigment), {roughness: .55},
      )));
    },
  },
  prismatic: {
    label: 'Prismatic shell',
    create() {
      const frame = named('pigmentSpace', domain.transform([
        1.8, 0, 0, 0,
        0, 1.3, 0, 0,
        0, 0, 1.8, 0,
        0, 0, 0, 1,
      ]));
      const noise = named('pigmentNoise', scalar.noise({seed: 11, domain: frame}));
      const height = scalar.ramp(scalar.axis('y'), -1, 1);
      const variation = named('pigmentVariation', scalar.add(
        scalar.multiply(.7, noise), scalar.multiply(.3, height),
      ));
      const body = named('shellPalette', color.ramp(variation, [
        [.12, named('shellIndigo', color.srgb('#344761'))],
        [.4, named('shellTeal', color.srgb('#629b9e'))],
        [.62, named('shellPearl', color.srgb('#c8d9ce'))],
        [.88, named('shellRose', color.srgb('#a18ba5'))],
      ], {space: 'oklab', interpolation: 'smoothstep'}));
      const shadow = named('shellDepth', color.mix(
        named('shellInk', color.srgb('#192b40')), body, .32, {space: 'oklab'},
      ));
      const light = named('shellGleam', color.mix(
        body, named('shellIvory', color.srgb('#ecdfb9')), .7, {space: 'oklab'},
      ));
      return materialGraph(named('prismaticPaint', surface.paint('carapace', {
        palette: {base: body, shadow, light},
      })));
    },
  },
  porcelain: {label: 'Carved porcelain', create: carvedPorcelain},
  weathered: {label: 'Weathered shell', create: weatheredShell},
  ivory: {label: 'Ink & ivory', create: inkIvory},
  brass: {label: 'Patinated brass', create: patinatedBrass},
  zones: {label: 'Cobalt & gilt', create: zonedEnamel},
  pigments: {label: 'Spectral patina', create: spectralPatina},
  inscription: {label: 'Inscribed glaze', create: inscribedGlaze},
  marks: {label: 'Painted carapace', create: paintedCarapace},
} satisfies Record<string, {label: string; create(): MaterialGraph}>);
