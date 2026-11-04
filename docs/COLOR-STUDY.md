# Color relationships and deliberate marks

Moonweave authoring is performed by LLM programs. The executable system generates resources, composes named zones and stores complete graph data. Production examples below are visual and architectural evidence; the implemented resource/application layer is documented in [APPLICATIONS.md](APPLICATIONS.md), with revision 56 sampling contracts in [FILTERING.md](FILTERING.md).

Research and design notes for Moonweave, reviewed 4 November 2026.

Moonweave should make a material's visual decisions composable: where a mark
exists, how its pigment relates to the surrounding palette, which physical
channels it changes, and how it is displayed. The useful target suggested by
Arcane is deliberate painting over coherent forms. A larger collection of noise
functions would address only part of that problem.

This study separates production evidence, reference systems, the changes
implemented in this revision, and remaining work. The systems below are useful
comparisons; their inclusion does not imply that Fortiche used their algorithms
or libraries.

## What the production sources establish

[Fortiche's FAQ](https://forticheprod.com/faq/) describes a visual philosophy
built around human imperfection, organic textures, painting, comics, and art
history. It lists Mari, Maya, Houdini, Nuke, Guerilla, and internal tools among
the studio's software. This supports an artist-directed, multidisciplinary
workflow; it does not identify one procedural texture formula.

In [Netflix's interview with Julien Georgel and Arnaud-Loris
Baudry](https://www.netflix.com/tudum/features/arcane-season-two-behind-the-scenes),
Janna's temple has a quiet, neutral environment that gives fluorescent graffiti
visual emphasis. The interview also discusses deliberately chosen lighting for
Vi and recurring spiral motifs in Viktor's commune. Its remarks about FX and
compositing doing most of the work concern the Black Rose prison sequence,
not the whole production.

Foundry's official [“Arcane S2 texturing: Animating the hand-painted
look”](https://www.youtube.com/watch?v=gCJIJG6Lz84) description identifies
Fortiche CTO Philippe Llerena, matte-painting supervisor Martin Bailly, Mari,
and assets including Jinx's airship. The description was retrieved, but the
video and its transcript were not inspected. No detailed technique is
attributed to that talk here.

**Design inference:** quiet areas, concentrated accents, palette families,
directional marks, and scene lighting need independent controls. A surface
package can support those decisions without claiming to reproduce an entire
studio's look.

## Color systems worth studying

| System and primary reference | Useful representation | Consequence for Moonweave |
| --- | --- | --- |
| [Color.js interpolation](https://colorjs.io/docs/interpolation.html) and [gamut mapping](https://colorjs.io/docs/gamut-mapping.html) | Working space, interpolation space, output space, and lossy gamut mapping are explicit choices. | Keep the core's extended coordinates. Add authoring conversions and gamut feedback at explicit boundaries. |
| [Culori](https://culorijs.org/api/) | Functions over ordinary color records; interpolators, per-channel choices, and separable conversion operations. | A strong example for a small functional API. Palette conveniences need not become new runtime graph operations. |
| [Oklab](https://bottosson.github.io/posts/oklab/) and [Okhsl/Okhsv](https://bottosson.github.io/posts/colorpicker/) | Perceived lightness and opponent coordinates support useful color edits. Picker-friendly coordinates address a different problem from perceptual distance. | Use Cartesian Oklab for field operations; choose picker coordinates for usability. Neither supplies a pigment model. |
| [OKLCH.com](https://oklch.com/) | Lightness, chroma, hue, gamut plots, wider-gamut inspection, and explicit sRGB fallback. | Show which colors a destination can reproduce. Three unconstrained sliders conceal the irregular shape of the gamut. |
| [OpenColorIO](https://opencolorio.org/) and [ACES Output Transforms](https://docs.acescentral.com/system-components/output-transforms/) | Scene data, creative transformations, rendering transforms, and display encoding have separate responsibilities. | Keep display appearance outside the material's reflectance expressions. A future export/view pipeline should name its source and destination spaces. |
| [Spectral.js](https://github.com/rvanwijnen/spectral.js) | Pigment-like mixing using spectral reflectance and Kubelka–Munk absorption/scattering relationships. | Begin with authored palette stops or baked mixture tables. A spectral mixture is richer data than three RGB numbers. |
| [Mixbox](https://github.com/scrtwpns/mixbox) | RGB-facing pigment-like mixing, including LUT and shader implementations. | Useful evidence that artist-friendly mixtures need different trajectories from RGB interpolation. Reuse requires attention to its noncommercial/commercial licensing split. |

Color.js and Culori have verified [MIT](https://github.com/color-js/color.js/blob/main/LICENSE)
[licenses](https://github.com/Evercoder/culori/blob/main/LICENSE). Their official
release listings currently show [Color.js
0.7.1](https://github.com/color-js/color.js/releases) and [Culori
4.0.2](https://github.com/evercoder/culori/releases). Color.js 0.7 introduces
gamut-relative LCH/OKLCH variants and reusable transformation matrices; Culori
4.0.2 updates Oklab matrices to match CSS Color 4. These are evidence of concrete
maintenance, not a reason to import either entire library into a fragment shader.

The [OKLCH picker is MIT](https://github.com/evilmartians/oklch-picker/blob/main/LICENSE).
[OpenColorIO is BSD 3-clause](https://github.com/AcademySoftwareFoundation/OpenColorIO/blob/main/LICENSE);
its homepage currently presents 2.5.0 with ACES 2.0 support. ACES is a color
pipeline reference, not a synonym for a filmic curve applied to albedo.

[Spectral.js 3.0.0 is MIT](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/LICENSE).
Its [implementation](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/spectral.js)
uses 38 reflectance samples and mixture weights influenced by luminance and
tinting strength. Mixbox's repository specifies CC BY-NC 4.0 for noncommercial
use and a separate commercial license. It is therefore not an automatic
permissive dependency for a reusable npm package. No dependency was added for
this revision, and no claim is made that either model exactly identifies real
pigments from an arbitrary RGB swatch.

### Four operations that must remain distinct

For implementation structure, [LYGIA](https://github.com/patriciogonzalezvivo/lygia)
is another useful reference: its small shader functions separate color spaces,
palettes, mixing, filtering, and spatial operations across shader languages.
Module size and explicit dependencies are useful lessons; individual licensing,
numerical conventions, and resource requirements still need inspection before
reuse. [MaterialX](https://materialx.org/) provides the complementary model of
typed material relationships exchanged across applications, with defined nodes
and shader generation. Neither is imported by this revision; Moonweave's
current graph is not a MaterialX document.

**Perceptual interpolation** chooses a useful path between color coordinates.
**Gamut mapping** changes a color to fit a reproducible destination.
**Pigment mixing** models combinations of absorbing and scattering materials.
**Display rendering** makes rendered scene data suitable for a chosen device
and viewing condition. Calling all four “blending” hides consequential choices.

For example, an Oklab lightness change may create an out-of-gamut intermediate.
Clipping it immediately can destroy the intended relationship to later edits.
Preserving it does not, however, make it valid physical reflectance or guarantee
that a screen can reproduce it. Moonweave retains this distinction.

## Mark systems worth studying

| System and primary reference | What it separates | Design lesson |
| --- | --- | --- |
| Material Maker [Shape](https://rodzill4.github.io/material-maker/doc/node_simple_shape.html) and [Controlled Variations](https://rodzill4.github.io/material-maker/doc/node_miscellaneous_variations_controlled.html) | Grayscale shape, size, edge width, and branch variation. | A reusable coverage field can be independent of the material consuming it. |
| Adobe Substance Designer [Tile Sampler](https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/substance-graphs/nodes-reference-for-substance-graphs/node-library/texture-generators/patterns/tile-sampler) | Pattern selection, placement, rotation, scale, tint, and masking. | Separate mark vocabulary from distribution. Adobe itself notes that the simpler Tile Generator often suffices. |
| Krita [Masked Brush](https://docs.krita.org/en/reference_manual/brushes/brush_settings/masked_brush.html) | Primary tip silhouette and a second tip controlling its internal coverage; independent size, spacing, and rotation. | Edge character and internal breakup should be controllable without replacing the entire mark. |
| MyPaint [brush settings](https://github.com/mypaint/libmypaint/blob/master/brushsettings.json) and [engine](https://www.mypaint.app/en/docs/backend/brush-engine/) | Dab geometry, pressure, speed, direction, filtering, and stroke state. | A temporal brush engine is more than a stateless noise field. Direction and spacing carry authored information. |
| Blender [Grease Pencil materials](https://docs.blender.org/manual/en/latest/grease_pencil/materials/index.html) | Stroke and fill appearance within shared material identity. | Keep line treatment and filled pigment related without forcing them into one channel. |
| [Sparse Gabor convolution](https://graphics.cs.kuleuven.be/publications/LLDD09PNSGC/) | Orientation, frequency, bandwidth, surface mapping, and anisotropic filtering. | Directional texture needs spectral and filtering controls. A direction field is more expressive than a fixed global stretch. |
| [Real-time hatching / tonal art maps](https://hhoppe.com/proj/hatching/) | Tone, stroke density, resolution, and curvature-directed surface placement. | Preserve recognizable marks across zoom, tone changes, and motion. Coherence is part of the representation. |

Material Maker's [root license](https://github.com/RodZill4/material-maker/blob/master/LICENSE.md)
is MIT unless otherwise specified; individual shader provenance still matters.
[libmypaint's ISC license](https://github.com/mypaint/libmypaint/blob/master/COPYING)
is permissive, but its C brush engine is not a JavaScript field evaluator that
can be adopted unchanged. The other rows are workflow or research references,
not bundled code. The Gabor project supplies a corrected paper and identifies
errata; implementation should use those corrections. Blender's [Gabor
documentation](https://docs.blender.org/manual/en/5.0/render/shader_nodes/textures/gabor.html)
also cautions that Gabor is more expensive than regular noise.

### Why one noise field for every channel is insufficient

Sharing a field is valuable when it expresses a real relationship: exposed
substrate might change both pigment and roughness. Reusing one undifferentiated
signal everywhere instead makes every color fleck a bump and every tonal
transition a roughness transition. That is an authoring restriction, even when
the result is numerically well behaved.

Broad form grouping, medium brush shapes, and fine grain need separate scale
and coverage decisions. Some paint marks should affect color alone. A scratch
may affect several channels at different strengths. Quiet regions must be
representable without removing the underlying material. These are design
inferences from the references, not assertions about Fortiche's shader code.

## Implemented in this revision

`color.adjust(input, {lightness, chroma, hue})` adds one Color operation with
Scalar ports. Defaults are `0`, `1`, and `0`. Lightness is a signed Oklab offset,
chroma a signed multiplier, and hue a periodic rotation in degrees. Given
Oklab coordinates `(L,u)`, with `u=(a,b)`, its action is

\[
A_{\ell,c,\theta}(L,u)=(L+\ell,cR_\theta u).
\]

Cartesian rotation preserves neutral colors without extracting an undefined
polar hue. Over real numbers, consecutive actions compose as

\[
(\ell_1,c_1,\theta_1)\circ(\ell_2,c_2,\theta_2)
=(\ell_1+\ell_2,c_1c_2,\theta_1+\theta_2).
\]

This is a monoid action; zero chroma scale is not invertible. The compiler
does not reassociate nonidentity nested edits using that real-number law.
Literal identities can disappear; editable parameters at identity stay live.
CPU color tangents include the derivatives of the input and all three controls.
Extended RGB is retained until the established material reflectance boundary.
Hue reduction is shared conceptually by CPU and GLSL; extreme values retain
ordinary backend precision limits.

`color.oklab([L,a,b])` and `color.oklch([L,C,hDegrees])` convert authoring values
once into the existing editable linear RGB color node. Canonical OKLCH input
requires nonnegative `C`; the adjustment's signed scale permits a half-turn
through a negative value.

`mask.interval` creates compact support with smooth inward transitions.
`mask.chisel` multiplies three interval masks in a local cube. A domain controls
placement, aspect, and rotation. Both expand into existing scalar operations;
they introduce no mask opcode, resource, or hidden random process. They have
analytic first derivatives and remain point samples, not integrated pixel
coverage. The same mask can drive a pigment mixture, a finish change, or height
with independently chosen strengths.

## Revision 55: procedural resources and spectral composition

The first resource layer is implemented: shared Image nodes, scalar/RGB readers, explicit planar coordinates and clamp/repeat addressing. LLM programs generate finite brush images and bake spectral pigment tables. Data is self-contained in the graph; Three owns reference-counted float textures. Named zones apply pigment, partial finish and height with separate semantics.

Actual source reviewed and adapted: [Spectral.js 3.0.0](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/spectral.js), with its [MIT license](https://github.com/rvanwijnen/spectral.js/blob/3.0.0/LICENSE). Moonweave retains the 38-band basis and D65 projection, stores additive concentration/K/S moments, and rationalizes the inverse to avoid cancellation for dark reflectances. The inspected branch snapshot and numerical table hash are recorded in `tests/fixtures/spectral-3.json`. It is not claimed to match an uninspected release commit.

[Color.js's actual gamut code](https://github.com/color-js/color.js/blob/f952b6bb959749c46a87ad189f0028b3eb5b5f05/src/toGamut.js) was reviewed for the explicit Oklch/chroma boundary. Moonweave does not silently add its mapping algorithm or claim channel clipping is perceptual mapping. Pigment inputs accept display-bounded linear RGB; their projected colors retain extended coordinates until the existing material reflectance boundary.

[MaterialX image sampling properties](https://materialx.org/docs/api/class_image_sampling_properties.html) provide a useful precedent for separating resources, coordinates, addressing and filtering. [Three DataTexture](https://threejs.org/docs/pages/DataTexture.html) supplies the upload boundary. Moonweave's bilinear reconstruction is independently implemented, with analytic UV partials and explicit high-precision samplers. It uses nearest float reads, not a dependency on hardware float-linear filtering.

## Revision 56: defined image sampling and filtering

The authored-resource priority now includes explicit footprints, deterministic
area-average mipmaps, trilinear reconstruction, bounded eight-tap anisotropic
sampling, and zero extension for finite marks. Color and scalar projections
share a sample; placements share storage. Virtual coarse zero levels retain
integrated mass while a mark becomes subpixel. Existing unfiltered documents
keep their meaning and generated shader text.

[OpenImageIO's TextureSystem](https://openimageio.readthedocs.io/en/stable/texturesys.html)
provides the useful distinction between pixel-footprint inputs and returned
filtered-value partials. [PBRT's image implementation](https://www.pbr-book.org/4ed/Textures_and_Materials/Image_Texture)
was inspected for mipmaps, singular footprint behavior and anisotropic tradeoffs.
Moonweave uses an independently implemented bounded line quadrature rather than
PBRT's EWA algorithm. It does not claim exact pixel integration or derivatives
through discrete tap-count changes.

The new Inscribed glaze study packs coverage, covered deposition and covered
polish into one RGB image, sampled in two frames. It preserves correlations
before filtering: in general `F(mask*height)` differs from
`F(mask)*F(height)`. The stored deposition is used directly as height, so its
coverage is not multiplied twice. This gives LLM authoring a compact place to
record a specific painted decision while retaining separate runtime controls.

## Broader directions beyond the completed resource layer

1. **Direction and placement fields.** Reusable flow, curvature/anatomical inputs, indexed mark placement and local density need bounded per-fragment work as mark count grows.
2. **Resource interoperability.** External asset references, image decoding, mesh UV inputs and bake/export backends can target the existing numeric resource contract.
3. **Gamut and display.** Destination mapping, diagnostic feedback, lighting and output-transform contracts remain distinct from spectral mixtures and material reflectance.
4. **Representative visual validation.** Cloth, skin and creature anatomy under motion and multiple lights will expose requirements beyond the current static specimens.

These directions remain outside the implemented resource layer. Revision 56
finishes its sampling contract and provides a directly reusable application;
it does not reproduce a production Arcane pipeline.
