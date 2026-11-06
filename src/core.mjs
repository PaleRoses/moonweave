/** Renderer-free authoring, validation, algebra and deterministic field generation. */
export {GRAPH_VERSION, GRAPH_LIMITS, FACET_KEYS, PALETTE_KEYS, STYLE_KEYS, SURFACE_SIGNATURE,
  scalar, color, image, domain, facets, surface, named, instantiate, inDomain, foldGraph, splitRecipe,
  expressionGraph, graphExpression, materialGraph, patchGraph, serializeGraph, parseExpressionGraph, parseGraph} from './core/graph.mts';
export {compileGraph} from './core/compile.mts';
export {inspectGraph} from './core/inspect.mts';
export {mask} from './core/masks.mts';
export {IMAGE_LIMITS} from './core/resources.mts';
export {coverage} from './core/coverage.mts';
export {zone, applyZones} from './core/zones.mts';
export {pigment} from './color/pigment.mts';
export {createFieldSampler, evaluateScalar, evaluateDomain, evaluateColor} from './core/evaluate.mts';
export {
  SURFACE_PRESETS, SURFACE_RECIPE_VERSION,
  normalizeSurfaceRecipe, patchSurfaceRecipe, normalizeFacetMapping, normalizePaintStyle,
} from './core/recipe.mts';
export {
  makePaintFields, drawingFieldBytes,
  PAINT_LAYOUT, PAINT_CHANNELS, PAINT_SIZE, PAINT_CELLS,
} from './paint/data.mts';

export * from './core/public-types.mts';
export {migrateSurfaceRecipe} from './core/migrate.mts';
export {toWorkingColor, convertColor, displayColor, decodeColorImage, encodeColorImage} from './color/management.mts';
export {MARK_LIMITS, markProgram, parseMarkProgram, serializeMarkProgram} from './paint/marks.mts';
export {compileMarkProgram, bakeMarks} from './paint/mark-raster.mts';
export {applyMarkBake} from './paint/mark-apply.mts';

/** Mesh curvature / authored fold guides become standard portable stroke marks. */
export {bakeMeshFlow, sampleFlow, traceFlow, guidedStrokes} from './paint/flow-guides.mts';
