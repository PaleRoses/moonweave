# Mesh-guided painterly stroke flow

A single diagonal texture-space stroke direction flattens curved cloth and
makes separate armor forms read as a single object. `bakeMeshFlow` constructs a
**line field** in UV space from the mesh instead. Every stroke step re-samples
the field. This is authoring-time work: the final material contains an ordinary
Moonweave mark bake and no geometry dependency or new shader operation.

## The four functions

```js
import {
  bakeMeshFlow, guidedStrokes, markProgram, bakeMarks, applyMarkBake,
  image, materialGraph, surface,
} from '@moonweave/surfaces/core';

// positions: xyz per vertex; uv: uv per vertex; indices: triangle triples.
// Indexed mesh normals can be supplied or estimated from neighboring faces.
// Provide foldGuides as xyz per vertex when form designers know the flow.
// ambientOcclusion is an optional [0,1] light-visibility scalar per vertex.
const guide = bakeMeshFlow({positions, uv, indices, foldGuides, ambientOcclusion}, {
  width: 128, height: 128, direction: 'along-fold',
});

const tip = image.generate({width: 24, height: 24, channels: 1}, (u, v) =>
  Math.max(0, 1 - Math.hypot(u - .5, v - .5) * 2),
).resource;

const marks = guidedStrokes(guide, {
  brush: 'bristle', seeds: [[.24, .42], [.38, .63], [.69, .25]],
  color: [.55, .32, .15], radius: .015, length: .12, step: .003,
  opacity: .55, aspect: .46, spacing: .42, shadowStrength: .55,
});
const program = markProgram({brushes: {bristle: {mask: tip}}, marks});
const bake = bakeMarks(program, {width: 128, height: 128, samples: 2});
const graph = materialGraph(applyMarkBake(surface.paint('carapace'), bake));
```

The output of `guidedStrokes` is the **existing** `MarkInput[]` grammar. Save it
with `serializeMarkProgram`; no traced strokes, mesh topology, or callbacks are
added to graph JSON. `bakeMeshFlow` returns plain `ImageInput`-shaped data for
optional visualization. It is not a new global cache or second graph language.

## Why double angles?

A fold points along a **line**. Reversing a triangle edge or a per-vertex guide
vector must not flip brush direction. The field stores
`[confidence × cos(2θ), confidence × sin(2θ), confidence]`. This allows signed
arrows 180 degrees apart to interpolate to the same orientation. Tracing uses
midpoint integration and transports the sign continuously from the previous
step, so a stroke bends with the surface and does not suddenly reverse.

When no explicit fold guides are supplied, a finite-difference surface shape
operator estimates local principal curvatures from normals and UV tangents.
`along-fold` follows the minimum **absolute** curvature direction (typically
along a fabric ridge). `across-fold` selects the maximum absolute curvature.
Low-anisotropy, flat and umbilic areas are not assigned a fake global stripe:
traces stop there. Artist-supplied per-vertex `foldGuides` define those areas
explicitly and take priority over curvature.

`ambientOcclusion` is light visibility, **not vertical position**. It modulates
pigment brightness per generated mark with `shadowStrength`; it leaves bump,
roughness, opacity and metalness independent. No height-based color band is
introduced. For more elaborate painterly value control, replace the input AO
with an artist-authored scalar that encodes crevice depth or diffuse shading.

## UV and performance contracts

`uv` coordinates must be in `[0,1]` for the painted atlas. Distinct forms should
use disjoint UV islands (or separately baked atlases), not silently share pixel
addresses. Coincident triangle edges are legal; two overlapping triangle
**interiors** are an error by default. `overlap:'first'` opts into first-owner
semantics for intentionally stacked UVs. Strokes stop when confidence is too
low or they reach an island boundary. UV lines do not teleport across seams.

The direction and AO maps are bounded by the existing 262,144-component image
budget; at 256×256 the combined maps use exactly four components per texel.
Source triangle rasterization scales with covered UV texels. Tracing is bounded
at 4,096 integration steps. Stroke budgets, dab limits, and paint deposition
continue to be enforced by `markProgram` and `bakeMarks`.

These are approximate discrete curvature directions, not a globally smooth
quad-mesh parameterization. On very sparse, noisy or irregularly triangulated
meshes, supply explicit `foldGuides` or improve the mesh normals. Across
strongly distorted UV layouts, uniform UV step length is not uniform world-space
brush length. A subsequent optional metric-aware tracing pass could address
this without modifying the mark grammar.

Relevant basis: Girshick et al., *Principal Direction Line Drawings of Polygonal
Surface Meshes* (2000); Zhang et al., *Interactive Tensor Field Design and
Visualization on Surfaces* (2007). The implementation is independent.