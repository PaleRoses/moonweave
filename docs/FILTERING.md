# Image resources, footprints and filtering

An image is shared
numeric data; each reader chooses its coordinates, addressing, channel and
filter. This keeps one painted decision reusable across placements and creatures
without expanding its texels into graph operations. Image resources and readers
belong to the same six-sort graph as procedural fields and surface composition.

## Author a resource and choose its interpretation

```js
import {
  image, scalar, color, named, zone, applyZones, surface, materialGraph,
  createFieldSampler,
} from '@moonweave/surfaces/core';

const marks = named('marks', image.generate(
  {width: 64, height: 64, channels: 3},
  (u, v) => {
    const coverage = Math.max(0, 1 - Math.hypot(2 * u - 1, 2 * v - 1));
    const height = .002 * (.6 + .4 * Math.sin(18 * v));
    return [coverage, coverage * height, coverage * .7];
  },
));
const options = {address: 'zero', filter: 'anisotropic'};
const coverage = scalar.image(marks, {...options, channel: 'r'});
const deposition = scalar.image(marks, {...options, channel: 'g'});
const polish = scalar.image(marks, {...options, channel: 'b'});
const painted = applyZones(surface.paint('carapace'), [
  zone('cobalt', coverage, {color: color.srgb('#214c67')}),
]);
const graph = materialGraph(surface.bump(surface.channels(painted, {
  roughness: scalar.add(.65, scalar.multiply(-.3, polish)),
}), deposition));

// CPU: the pixel footprint is explicit and independent of derivative directions.
const sample = createFieldSampler(coverage);
const result = sample({
  position: [.4, .6, 0],
  dx: [1, 0, 0], dy: [0, 1, 0],
  footprint: {dx: [.06, .01, 0], dy: [0, .015, 0]},
});
```

The callback runs once during authoring. Saved JSON contains owned float32
samples, dimensions and channel count. Row zero is the lower image edge;
texel centers are `(i + .5) / size`. Scalar data has no color encoding. RGB
readers interpret their channels as extended linear Rec.709; decode display
colors before supplying RGB image data. An RGB resource can instead pack three
unrelated scalar channels, as above. It has no implicit alpha channel.

Place readers with `domain: frame`, or place a complete expression with
`inDomain(expression, frame)`. The affine frame maps the host's rest position
into image UV in its XY coordinates. Reuse the owned `marks` object; named
instances can explicitly share that resource while copying local parameters.
The `Inscribed glaze` example uses this pattern with two placements.

## Addressing and filtering are independent

| Setting | Contract |
| --- | --- |
| `address: 'clamp'` | Extend the edge texel; useful for palettes and nonrepeating backgrounds. |
| `address: 'repeat'` | Periodic texel lattice with interpolation across the seam. |
| `address: 'zero'` | Every texel outside the image is zero; useful for finite marks and masks. |
| `filter: 'linear'` | Four-corner bilinear reconstruction of level zero. This is the backward-compatible default. |
| `filter: 'trilinear'` | Reconstruct adjacent mip levels selected from the footprint's largest singular length; interpolate values and partials. |
| `filter: 'anisotropic'` | Average at most eight trilinear midpoint samples along the footprint's major axis, retaining more detail along its minor axis. |

An omitted filter and an explicit `linear` filter normalize to the same graph.
Existing documents therefore keep their program keys and shaders. Filtering is
structural metadata on the reader; changing it regenerates a program. Pixels,
dimensions and channel count remain editable resource bindings. Changing them
replaces the owned texture without changing the program's structure.

For an absent or zero CPU footprint, all three policies return the original
point reconstruction. Merely setting `SampleContext.dx` and `dy` does not turn
on filtering. The Three adapter obtains pixel tangents from the unwrapped
domain position using screen derivatives. Repeated coordinates are reduced
before adding filter offsets to avoid losing precision far from the origin.

## Footprint and differential calculus

Let `px` and `py` be the image-UV displacement vectors for a screen pixel. In
base texel coordinates, the footprint is

\[
J=\begin{bmatrix}w p_{x,u}&w p_{y,u}\\h p_{x,v}&h p_{y,v}\end{bmatrix}.
\]

The eigenvectors of `J Jᵀ` determine its principal directions; the square roots
of its eigenvalues give major and minor lengths `a ≥ b`. The implementation
normalizes twice and uses logarithmic lengths to avoid overflowing intermediate
texel spans. A one-texel clamp/repeat axis is constant and does not enlarge the
footprint; a one-texel zero-extended axis retains finite edges.

Trilinear filtering chooses `lod = max(0, log2(a))`. Anisotropic filtering uses
`width = max(1, b, a/8)` and `lod = log2(width)`, with at most eight taps spanning
the major direction. The tap count is `ceil(a/width - 1e-6)`, bounded to `[1,8]`;
the explicit small guard stabilizes integer ratios under floating-point
rotation. Tap-count changes remain discrete. This is bounded line quadrature,
not EWA filtering or an exact integration over the screen pixel.

`SampleContext.dx` and `dy` are arbitrary differentiation directions. The
independent `footprint` describes the sample's area. Affine domains transport
both by their linear part; translation changes neither. Returned partials hold
the footprint, chosen LOD and tap offsets fixed:

\[
D F=F_u\,D u+F_v\,D v.
\]

The existing chain and product rules then apply to the reconstructed fields.
They are not derivatives through changes of the filtering algorithm itself.
Mip-level interpolation is continuous at integer LODs for a fixed tap plan;
bilinear spatial derivatives remain piecewise, with the established one-sided
knot convention. Anisotropic tap transitions do not promise temporal smoothness.

### Preserve correlated authoring decisions before filtering

For a linear filter `F`, generally `F(mh) ≠ F(m)F(h)`. If coverage and deposition
must be integrated together, bake `m*h` into one channel and use that channel
directly as height, as the example does. Multiplying the filtered coverage by
the already-covered height would mask it a second time. Ordinary
`zone(..., {height})` still means the product of its coverage and height fields
with the full differential `D(mh) = m Dh + h Dm`. Filtering image leaves does
not antialias every nonlinear operation later applied to them.

## Mip reduction and finite marks

Each level has `max(1, floor(size/2))` texels on each axis. Every destination
texel is a positive, normalized area average over overlapping source cells,
including the last row and column of odd dimensions. Levels are rounded to
float32. They preserve component bounds and mean up to that rounding. The
original owned resource is level zero; derived levels are shared through a
weak cache and never serialized into the graph.

Clamped and repeated images stop at their final stored level. A zero-extended
image must keep fading when its finite mark becomes smaller than a pixel.
For an integer level `L`, after an axis collapses we rescale its coordinate
about `.5` by

\[
r_i=2^{\min(0,\log_2(s_i)-L)},\qquad q_i=.5+(u_i-.5)r_i.
\]

The sampled value is multiplied by `r_u r_v`, its `u` partial additionally by
`r_u`, and its `v` partial additionally by `r_v`. These virtual coarse levels
retain integrated mask mass while widening support and reducing amplitude.
There is no permanent average-color plateau outside a disappearing stamp.
This scale-space is the defined approximation, including for odd dimensions;
it is not exact geometric pixel coverage. Outside a level's finite tent support,
sampling returns zero before multiplying large coordinates by texel dimensions.

## Sharing, storage and work

The canonical sampling identity is `(image, domain, address, filter)`. RGB and
scalar channel projections share that reconstruction. Different placements
reuse storage but require separate samples. Independently editable images and
frames remain distinct even when their current values match.

| Reader policy | Maximum nearest texel fetches per shared reconstruction |
| --- | ---: |
| Linear | 4 |
| Trilinear | 8 |
| Anisotropic | 64 |

`compileGraph(graph).cost.textureReads` reports this static ceiling plus the
existing facet-atlas work. Magnification, integer LODs, fewer taps and zero
support can use less. It is not a measured frame time. The full mip pyramid is
uploaded once per owned resource as nearest-sampled RGBA32F data, with automatic
mipmap generation disabled. Linear and filtered readers share the same texture.
Square power-of-two pyramids approach 4/3 of the base texel count; one-row
pyramids remain below twice the base count. Driver and JavaScript overhead are
additional. The 262,144 authored-component budget excludes derived levels.

## Integration and scope

The adapter requires WebGL2 and the host's Three capabilities, including
`FloatType`, `NearestFilter` and `ClampToEdgeWrapping`. Full `import * as THREE`
works; narrow capability records must include them. The core itself requires
neither a renderer nor the browser. The package ships standalone declarations,
and `examples/inscription.json` is the complete resource-bearing example.

This layer supplies embedded numeric images and planar sampling. External image
decoding, mesh-UV/UDIM inputs, nonlinear warps, hardware EWA and full-material
supersampling are outside it. Existing procedural noise and analytic masks keep
their point-sampling semantics. Resource filtering does not enable WebGL in a
browser that refuses context creation.

## Design references and evidence

[OpenImageIO TextureSystem](https://openimageio.readthedocs.io/en/stable/texturesys.html)
separates pixel-footprint inputs from output value partials and makes wrap modes
explicit. [PBRT's Image Texture](https://www.pbr-book.org/4ed/Textures_and_Materials/Image_Texture)
explains mip selection and anisotropic filtering; its EWA algorithm is a richer
reference, not the algorithm claimed here. [Three DataTexture](https://threejs.org/docs/pages/DataTexture.html)
defines the raw upload boundary. This revision's filtering implementation is
independently written; no new upstream source was copied.

`docs/VERIFICATION.md` in the source archive records the completed checks.
`docs/history/0.56/filtering56.json` in the source archive compares the actual implementation with an
independent analytic image-area reference and records representation costs.
