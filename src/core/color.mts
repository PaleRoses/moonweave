import type {Vec3} from './algebra.mts';
type ColorMatrix = readonly [Vec3, Vec3, Vec3];

/** Reflected sRGB transfer functions also preserve extended negative channels. */
export const decodeSrgbChannel = (value: number): number => Math.abs(value) <= .04045
  ? value / 12.92 : Math.sign(value) * ((Math.abs(value) + .055) / 1.055) ** 2.4;
export const encodeSrgbChannel = (value: number): number => Math.abs(value) <= .0031308
  ? 12.92 * value : Math.sign(value) * (1.055 * Math.abs(value) ** (1 / 2.4) - .055);

/** Decode an authored sRGB hex value to linear Rec.709 RGB once, before mixing. */
export function srgbToLinear(hex: string): Vec3 {
  if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex)) {
    throw new TypeError('sRGB color must be a six-digit hex value such as #c3a7e1.');
  }
  const packed = Number.parseInt(hex.slice(1), 16);
  return [16, 8, 0].map(shift => {
    const value = ((packed >> shift) & 255) / 255;
    return decodeSrgbChannel(value);
  }) as [number, number, number];
}

const matrix = (rows: ColorMatrix): ColorMatrix => Object.freeze([Object.freeze(rows[0]), Object.freeze(rows[1]), Object.freeze(rows[2])] as const);

/**
 * Oklab's D65 matrices, with the RGB/XYZ stages multiplied together once.
 * The 64-bit coefficients follow CSS Color 4 §19, including Color.js's
 * consistent-white-point correction. Rows are stored in mathematical order;
 * the GLSL emitter derives its column-major constants from this same table.
 * https://www.w3.org/TR/2026/CRD-css-color-4-20261103/#color-conversion-code
 * Original model and freely available reference: Björn Ottosson,
 * https://bottosson.github.io/posts/oklab/
 */
export const OKLAB_MATRICES = Object.freeze({
  rgbToLms: matrix([
    [0.41222146947076305, 0.5363325372617348, 0.05144599326750221],
    [0.21190349581782522, 0.68069955064523435, 0.10739695353694055],
    [0.088302459190056429, 0.28171883913612145, 0.62997870167382219],
  ]),
  lmsToLab: matrix([
    [0.2104542683093140, 0.7936177747023054, -0.0040720430116193],
    [1.9779985324311684, -2.4285922420485799, 0.4505937096174110],
    [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
  ]),
  labToLms: matrix([
    [1.0000000000000000, 0.3963377773761749, 0.2158037573099136],
    [1.0000000000000000, -0.1055613458156586, -0.0638541728258133],
    [1.0000000000000000, -0.0894841775298119, -1.2914855480194092],
  ]),
  lmsToRgb: matrix([
    [4.0767416360759583, -3.3077115392580616, 0.23096990318210442],
    [-1.2684379732850319, 2.6097573492876882, -0.34131937600265727],
    [-0.0041960761386755658, -0.7034186179359363, 1.7076146940746117],
  ]),
});

export function multiplyColorMatrix(rows: ColorMatrix, value: Vec3): Vec3 {
  const [x, y, z] = value;
  return [
    rows[0][0] * x + rows[0][1] * y + rows[0][2] * z,
    rows[1][0] * x + rows[1][1] * y + rows[1][2] * z,
    rows[2][0] * x + rows[2][1] * y + rows[2][2] * z,
  ];
}

/** Convert extended-range linear RGB without clipping or gamut mapping. */
export function linearToOklab(value: Vec3): Vec3 {
  const lms = multiplyColorMatrix(OKLAB_MATRICES.rgbToLms, value);
  return multiplyColorMatrix(OKLAB_MATRICES.lmsToLab,
    [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

export function oklabToLinear(value: Vec3): Vec3 {
  const lms = multiplyColorMatrix(OKLAB_MATRICES.labToLms, value);
  return multiplyColorMatrix(OKLAB_MATRICES.lmsToRgb,
    [lms[0] * lms[0] * lms[0], lms[1] * lms[1] * lms[1], lms[2] * lms[2] * lms[2]]);
}

/** Periodic hue in degrees, reduced before trigonometry on both CPU and GPU.
 * The composed rotation stays smooth across the reduction seam; its derivative
 * with respect to the authored degree value is always Math.PI / 180.
 */
export function hueRadians(degrees: number): number {
  return (degrees - 360 * Math.floor((degrees + 180) / 360)) * (Math.PI / 180);
}

/** Convert authored OKLCH to extended linear RGB; hue is in degrees. */
export function oklchToLinear(value: Vec3): Vec3 {
  const [lightness, chroma, hue] = value, angle = hueRadians(hue);
  return oklabToLinear([lightness, chroma * Math.cos(angle), chroma * Math.sin(angle)]);
}
