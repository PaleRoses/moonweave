import {
  applyZones, color, coverage, domain, image, materialGraph, named, pigment, scalar, surface, zone,
} from '@moonweave/surfaces/core';
import type {DomainExpression, ImageExpression, ImageFilter, ScalarExpression} from '@moonweave/surfaces/core';

const smooth = (low: number, high: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** A tabulated, finite brush: taper, bent edge and three broad bristle ribbons. */
function brushImage(id: string): ImageExpression {
  return named(id, image.generate({width: 32, height: 32, channels: 1}, (u, v) => {
    const center = .5 + .055 * Math.sin(v * 7.5);
    const width = .22 + .055 * Math.sin(v * 5.1 + .4);
    const edge = 1 - smooth(width * .73, width, Math.abs(u - center));
    const tips = smooth(.04, .19, v) * (1 - smooth(.79, .97, v));
    const bristles = .77 + .15 * Math.cos((u + v * .027) * Math.PI * 12)
      + .08 * Math.cos((u - v * .041) * Math.PI * 26);
    return edge * tips * bristles;
  }));
}

/** Affine pullback from an object plane to the image's [0,1]² coordinates. */
function brushFrame(id: string, x: number, y: number,
  halfWidth: number, halfLength: number, angle: number): DomainExpression {
  const radians = angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  return named(`${id}Space`, domain.transform([
    c / (2 * halfWidth), -s / (2 * halfLength), 0, 0,
    s / (2 * halfWidth), c / (2 * halfLength), 0, 0,
    0, 0, 1, 0,
    .5 - (c * x + s * y) / (2 * halfWidth), .5 + (s * x - c * y) / (2 * halfLength), 0, 1,
  ]));
}

function brush(id: string, source: ImageExpression, x: number, y: number,
  halfWidth: number, halfLength: number, angle: number): ScalarExpression {
  return named(id, scalar.image(source, {domain: brushFrame(id, x, y, halfWidth, halfLength, angle), address: 'clamp'}));
}

/** One generated resource drives a cobalt deposit, its height and a gold reveal. */
export function zonedEnamel() {
  const source = brushImage('enamelBrush');
  const sweep = brush('enamelSweep', source, -.25, -.06, .78, 1.6, -26);
  const scratch = brush('enamelScratch', source, .49, .18, .19, .92, 22);
  const exposure = named('enamelExposure', scalar.add(.3, scalar.multiply(.7,
    scalar.ramp(scalar.facing([.85, .25, .25], undefined, true), .4, .88))));
  const quiet = coverage.complement(coverage.union(sweep, scratch));
  const wash = scalar.multiply(sweep, named('enamelWashStrength', scalar.parameter(.87)));
  const reveal = scalar.multiply(coverage.intersect(scratch, exposure),
    named('enamelRevealStrength', scalar.parameter(.9)));
  const body = named('enamelBody', surface.paint({
    palette: {base: color.srgb('#d2d4c3'), shadow: color.srgb('#687780'), light: color.srgb('#eee7cf')},
    mapping: {scale: .19, stretch: [.98, 1.24, 1], rotation: -19, seed: 53017,},
    style: {
    contrast: .4, wash: .27, marks: .27, quiet: .86,
    relief: .09, roughness: .64, roughnessVariation: .06, metalness: 0, clearcoat: .07,
    },
  }));
  return materialGraph(named('enamelSurface', applyZones(body, [
    zone('enamelQuietBody', quiet, {channels: {roughness: .72, clearcoat: .035}}),
    zone('enamelCobaltWash', wash, {
      color: named('enamelCobalt', color.srgb('#244a73')),
      channels: {roughness: .48, clearcoat: .17},
      height: named('enamelDeposit', scalar.parameter(.0035)),
    }),
    zone('enamelGoldReveal', reveal, {
      color: named('enamelGold', color.srgb('#cfac64')),
      channels: {roughness: .34, metalness: .55, clearcoat: .06},
      height: named('enamelInlayHeight', scalar.parameter(.0018)),
    }),
  ])));
}

/** Spectral mixing runs at authoring time; the shader samples a 64-texel palette. */
export function spectralPatina() {
  const yellow = pigment.srgb('#dcc878'), blue = pigment.srgb('#315e79');
  const palette = named('patinaPigmentTable', image.generate({width: 64, height: 1, channels: 3},
    (_u, _v, x) => pigment.toLinear(pigment.mix(yellow, blue, x / 63))));
  const paletteSpace = named('patinaPaletteSpace', domain.transform([
    .15, 0, 0, 0, .12, 1, 0, 0, 0, 0, 1, 0, .52, 0, 0, 1,
  ]));
  const paint = named('patinaPigment', color.image(palette, {domain: paletteSpace, address: 'clamp'}));
  const source = brushImage('patinaBrush');
  const deposit = brush('patinaDeposit', source, -.32, -.1, 1.05, 1.65, 18);
  const scrape = brush('patinaScrape', source, .52, .34, .22, .84, -31);
  const exposed = coverage.intersect(scrape,
    scalar.add(.35, scalar.multiply(.65, scalar.ramp(scalar.facing([.7, .4, .2], undefined, true), .35, .85))));
  const wash = scalar.multiply(coverage.subtract(deposit, exposed),
    named('patinaAmount', scalar.parameter(.9)));
  const body = named('patinaBody', surface.paint({
    palette: {base: color.srgb('#9c8e6e'), shadow: color.srgb('#455657'), light: color.srgb('#d9c99a')},
    mapping: {scale: .23, stretch: [1, 1.35, 1], rotation: 17, seed: 41321,},
    style: {
    contrast: .47, wash: .28, marks: .3, quiet: .84,
    relief: .09, roughness: .57, roughnessVariation: .06, metalness: .27, clearcoat: .025,
    },
  }));
  return materialGraph(named('patinaSurface', applyZones(body, [
    zone('patinaQuietBody', coverage.complement(coverage.union(deposit, scrape)), {
      channels: {roughness: .63, clearcoat: .015},
    }),
    zone('patinaPigmentWash', wash, {
      color: paint, channels: {roughness: .76, metalness: .035, clearcoat: .01},
      height: named('patinaThickness', scalar.parameter(.0025)),
    }),
    zone('patinaExposedBrass', exposed, {
      color: named('patinaBrass', color.srgb('#d1b979')),
      channels: {roughness: .35, metalness: .55},
      height: named('patinaScrapeDepth', scalar.parameter(-.0015)),
    }),
  ])));
}

/**
 * A generated control atlas, shared by two placements. The channels retain the
 * authored correlations before filtering: coverage, covered deposition, and
 * covered polish. The deposition is applied directly, without a second mask.
 */
export function inscribedGlaze(filter: ImageFilter = 'anisotropic') {
  const atlas = named('inscriptionAtlas', image.generate({width: 128, height: 64, channels: 3}, (u, v) => {
    const bend = .5 + .045 * Math.sin(v * 8);
    const width = .25 + .055 * Math.sin(v * 4.7 + .3);
    const edge = 1 - smooth(width * .72, width, Math.abs(u - bend));
    const tips = smooth(.025, .17, v) * (1 - smooth(.8, .98, v));
    const ribbon = .5 + .5 * Math.cos(2 * Math.PI * (u * 37 + v * .65));
    const grain = .5 + .5 * Math.sin(2 * Math.PI * (v * 13 - u * 2.5));
    const covered = edge * tips * (.3 + .7 * ribbon);
    return [covered, covered * (.3 + .7 * grain), covered * (.55 + .45 * ribbon)];
  }));
  const placement = (id: string, x: number, y: number, halfWidth: number, halfLength: number, angle: number) => {
    const frame = brushFrame(id, x, y, halfWidth, halfLength, angle);
    const read = (channel: 'r' | 'g' | 'b', suffix: string) => named(`${id}${suffix}`,
      scalar.image(atlas, {domain: frame, address: 'zero', filter, channel}));
    return {coverage: read('r', 'Coverage'), deposition: read('g', 'Deposition'), polish: read('b', 'Polish')};
  };
  const sweep = placement('inscriptionSweep', -.25, -.08, .77, 1.55, -24);
  const accent = placement('inscriptionAccent', .45, .2, .16, .95, 23);
  const strength = named('inscriptionStrength', scalar.parameter(.9));
  const body = named('inscriptionBody', surface.paint({
    palette: {base: color.srgb('#c9d5c5'), shadow: color.srgb('#486674'), light: color.srgb('#eee4cb')},
    mapping: {scale: .2, stretch: [1, 1.28, 1], rotation: -17, seed: 56037,},
    style: {
    contrast: .42, wash: .28, marks: .25, quiet: .86,
    relief: .08, roughness: .66, roughnessVariation: .04, metalness: .02, clearcoat: .025,
    },
  }));
  const painted = applyZones(body, [
    zone('inscriptionInk', scalar.multiply(sweep.coverage, strength), {
      color: named('inscriptionCobalt', color.srgb('#214c67')),
    }),
    zone('inscriptionGilt', scalar.multiply(accent.coverage, strength), {
      color: named('inscriptionCopper', color.srgb('#b9854f')),
    }),
  ]);
  const polish = coverage.union(sweep.polish, accent.polish);
  const finished = surface.channels(painted, {
    roughness: scalar.add(.68, scalar.multiply(-.28, polish)),
    clearcoat: scalar.add(.025, scalar.multiply(.15, polish)),
  });
  const deposited = scalar.add(sweep.deposition, scalar.multiply(.7, accent.deposition));
  return materialGraph(named('inscriptionSurface', surface.bump(finished,
    scalar.multiply(deposited, scalar.multiply(strength, named('inscriptionDepth', scalar.parameter(.0016)))))));
}
