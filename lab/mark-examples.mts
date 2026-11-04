import {
  applyMarkBake, bakeMarks, color, displayColor, image, markProgram,
  materialGraph, named, surface, toWorkingColor,
} from '@moonweave/surfaces/core';
import type {MarkInput, MarkProgram, MaterialGraph, Vec3} from '@moonweave/surfaces/core';

const smooth = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** The named display boundary selects printable/paintable Rec709 reflectance. */
const reflectance = (lightness: number, chroma: number, hue: number): Vec3 =>
  toWorkingColor(displayColor({space: 'oklch', coords: [lightness, chroma, hue]}, 'srgb'));

/** Reusable paths, pressure and material decisions; no bitmap input is required. */
export function carapaceMarkProgram(): MarkProgram {
  const tip = image.generate({width: 32, height: 32, channels: 1}, (u, v) => {
    const edge = 1 - smooth(.65, 1, Math.hypot((u - .5) * 2, (v - .5) * 2));
    const ribbons = .65 + .23 * Math.cos(v * Math.PI * 16 + Math.sin(u * 8))
      + .12 * Math.cos(v * Math.PI * 38 - u * 3);
    return edge * ribbons;
  }).resource;
  const chisel = image.generate({width: 32, height: 32, channels: 1}, (u, v) => {
    const bevel = smooth(.02, .13, u) * (1 - smooth(.78, .98, u));
    const taper = 1 - smooth(.18, .46, Math.abs(v - .5 - .06 * Math.sin(u * 9)));
    return bevel * taper * (.8 + .2 * Math.cos(v * 82 + u * 8));
  }).resource;
  const body = image.generate({width: 48, height: 64, channels: 1}, (u, v) =>
    smooth(.015, .16, v) * (1 - smooth(.82, .98, v))
      * (1 - smooth(.72, 1, Math.abs(u - .5) * 2))).resource;
  const palette = [reflectance(.43, .08, 246), reflectance(.58, .09, 215), reflectance(.72, .06, 190)];
  const marks: MarkInput[] = [];
  for (const side of [-1, 1]) for (let row = 0; row < 6; row++) {
    const y = -.97 + row * .34;
    const points = Array.from({length: 9}, (_, i) => {
      const t = i / 8;
      return {at: [side * (.06 + .83 * t), y + .38 * Math.sin(t * 2.2) - .14 * t] as const,
        pressure: .3 + .7 * Math.sin(Math.PI * (.1 + .8 * t))};
    });
    marks.push({kind: 'stroke', brush: 'ribbon', zone: 'shell', color: palette[row % palette.length],
      points, radius: .115 + .013 * (row % 3), aspect: .52, spacing: .55, opacity: .46,
      height: .0015, channels: {roughness: .76, metalness: .03}});
  }
  const gold = reflectance(.76, .12, 79), ivory = reflectance(.9, .025, 91);
  for (let row = 0; row < 9; row++) {
    const y = -1.12 + row * .28, angle = .26 * Math.sin(row * 1.7), c = Math.cos(angle), s = Math.sin(angle);
    marks.push({kind: 'dab', brush: 'chisel', zone: 'shell', color: row % 3 === 0 ? ivory : gold,
      opacity: .7, height: .004, channels: {roughness: .38, metalness: .45, clearcoat: .14},
      transform: [.16 * c, .16 * s, -.28 * s, .28 * c, -.08 + .025 * Math.sin(row * 2), y]});
  }
  return markProgram({brushes: {ribbon: {mask: tip}, chisel: {mask: chisel}},
    zones: {shell: {mask: body, transform: [2.3, 0, 0, 3.1, -1.15, -1.55]}}, marks});
}

/** A complete reusable application: 21 authored marks become one compact deposition graph. */
export function paintedCarapace(): MaterialGraph {
  const baked = bakeMarks(carapaceMarkProgram(), {width: 128, height: 128,
    bounds: [-1.3, -1.6, 1.3, 1.6], samples: 2});
  const body = named('gestureCarapace', surface.paint('carapace', {palette: {
    base: color.linear(reflectance(.31, .035, 237)),
    shadow: color.linear(reflectance(.19, .035, 265)),
    light: color.linear(reflectance(.52, .045, 210)),
  }}));
  return materialGraph(named('paintedCarapace', applyMarkBake(body, baked)));
}
