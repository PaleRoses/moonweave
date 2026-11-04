# Color boundaries

Moonweave uses one working color representation: extended, linear-light Rec.709
RGB with the D65 white point. Graph colors, color images, Oklab operations and
palette inputs all carry this representation. An encoded sRGB value is an input
or output representation, not a second palette path.

`src/color/management.mts` owns the color-management boundary. The existing
`src/core/color.mts` owns the shared transfer curves, Oklab matrices and coordinate
math used by both authoring and graph interpretation. These functions are strict
TypeScript; their public declarations are generated from their implementations.

## Supported coordinates

| Tag | Coordinates | Transfer / white point |
| --- | --- | --- |
| `linear-rec709` | Linear red, green, blue | Working Rec.709 primaries, D65 |
| `srgb` | Encoded red, green, blue | Reflected sRGB transfer curve, D65 |
| `display-p3` | Encoded red, green, blue | Display P3 primaries, sRGB transfer curve, D65 |
| `linear-display-p3` | Linear red, green, blue | Display P3 primaries, D65 |
| `oklab` | Lightness, a, b | Existing canonical Oklab matrices |
| `oklch` | Lightness, nonnegative chroma, hue in degrees | Polar Oklab; hue wraps periodically |

The tagged data type is `TaggedColor<Space>`, containing `space` and `coords`.
RGB channels and Oklab lightness have a nominal 0–1 range. Ordinary conversion
preserves negative and above-one values. This permits wide-gamut colors to pass
through the working space without being clipped during editing or interpolation.
Coordinates must remain finite and representable by the graph's float32 bounds.
Achromatic conversion to OKLCH uses zero hue instead of a NaN sentinel.

This is an SDR, D65 RGB pipeline. It does not interpret ICC profiles, adapt an
arbitrary illuminant, tone-map HDR luminance, or implement a photographic
perceptual rendering intent. Alpha belongs to coverage/material channels rather
than the three-coordinate color type.

## Import, conversion and display

```ts
import {
  color, convertColor, displayColor, toWorkingColor,
} from '@moonweave/surfaces/core';

const source = {space: 'display-p3', coords: [1, 0, 0]} as const;

// Extended values survive: approximately [1.22494, -0.04206, -0.01964].
const working = toWorkingColor(source);
const field = color.linear(working);

// Coordinate conversion never selects a display gamut or clips.
const perceptual = convertColor(source, 'oklch');
const roundtrip = convertColor(perceptual, 'display-p3');

// This is the explicit, lossy output boundary.
const encodedSrgb = displayColor(source, 'srgb');

// Marks deposit unit-range reflectance; select the target appearance first.
const reflectance = toWorkingColor(encodedSrgb);
```

`toWorkingColor` returns a frozen `Vec3`. `convertColor(input, destination)` and
`displayColor(input, destination)` return frozen tagged values and retain the
destination's literal type. No API mutates an input. Existing `color.srgb(hex)`,
`color.oklab(...)` and `color.oklch(...)` constructors lower to the same linear
color node; the hex path shares its transfer function with managed conversion.

`displayColor` requires `srgb` or `display-p3` explicitly. It applies CSS Color 4
binary search with local MINDE, then encodes the destination RGB channels. The
search reduces OKLCH chroma at fixed lightness and hue, allowing local clipping
within a deltaEOK threshold of 0.02; its search tolerance is 0.0001. In-gamut
colors retain their appearance. Out-of-range lightness maps to black or white.
As with all numeric conversions, floating-point roundoff remains possible.

This boundary is independent of the material renderer. Three receives linear
surface reflectance and owns its lighting and framebuffer output conversion.
Calling `displayColor` on an already encoded framebuffer color and then sending
it as a linear material would encode it twice. Store linear colors in the graph;
use encoded values for the intended output format.

## RGB resource import and export

Custom RGB images in graph JSON are linear numeric samples. Mips must therefore
be derived after the source encoding has been decoded:

```ts
import {decodeColorImage, encodeColorImage, color, image} from '@moonweave/surfaces/core';

const encoded = {
  width: 2, height: 1, channels: 3 as const,
  data: [0, .5, 1, 1, .5, 0],
};
const linear = decodeColorImage(encoded, 'srgb');
const texture = color.image(image.data(linear), {
  address: 'zero', filter: 'anisotropic',
});
const output = encodeColorImage(linear, 'display-p3');
```

Both image functions use the existing immutable float32 resource owner and
return numeric RGB resources. They do not read files, decode PNG/JPEG containers,
interpret embedded metadata or write image files. The surrounding importer
supplies the source tag and the encoder supplies the destination file format.
`encodeColorImage` performs the same explicit gamut mapping as `displayColor`.

Scalar images contain unencoded data: masks, roughness, height, concentrations
or other numeric quantities. Both color image boundary functions reject scalar
images. Premultiplied pigment images must be composited or unassociated with their
coverage before use as standalone opaque display images; encoding premultiplied
numbers directly does not perform that compositing step.

## References and verification

The D65 primary transforms, reflected transfer curves and local-MINDE procedure
follow [CSS Color 4, 3 November 2026](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/),
sections 19 and 14.2.2. [Color.js's gamut-mapping guide](https://colorjs.io/docs/gamut-mapping)
also makes conversion and explicit gamut mapping separate operations. Moonweave
reuses its own canonical Oklab implementation rather than maintaining another
matrix set or importing a second runtime color algebra.

`src/color/COLOR-LICENSE.txt` contains the complete W3C source notice and describes
the modifications. No Color.js implementation source was copied. The original
Oklab model is described by [Björn Ottosson](https://bottosson.github.io/posts/oklab/).

`tests/color-management.test.mjs` verifies primary conversion, extended roundtrips,
the transfer-curve seams, the explicit display boundary, image ownership and
scalar-data rejection. `tests/marks-color.types.mts` checks destination literals
and incorrect graph-sort usage through the public package API.
