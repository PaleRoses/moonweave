// Type exports only: contracts are owned by the implementation or graph data module.
export type {
  SurfaceRecipe, SurfacePatch, SurfacePreset, FacetMapping, SurfaceStyle, StylePatch,
  Channel, Axis, Vec3, ColorSpace, ColorInterpolation, PaletteRole, PaintPalette, PaintPalettePatch,
  ImageResource, ImageAddress, ImageFilter, ImageChannel,
  DomainExpression, FacetExpression, ScalarExpression, ColorExpression, ImageExpression,
  SurfaceExpression, GraphExpression, GraphNode, GraphNodeOf, GraphSort, NodeKind,
  ResultSort, ResolvedNode, Algebra, Interpretation,
} from './algebra.mts';
export type {
  NamedExpression, InstanceOptions, InstantiatedExpression, ExpressionGraph, MaterialGraph,
  GraphDocument, GraphInput, ExpressionInput, ExpressionRoot, NodeValuePatch, GraphPatch,
  GraphBinding, GraphCost, GraphStructure, GraphPlan,
} from './types.mts';
export type {
  ImageSampleOptions, ColorRampStop, ColorMixOptions, ColorRampOptions, ColorAdjustOptions, PaintOptions, DepositChannel, DepositChannels,
} from './graph.mts';
export type {ImageShape, ImageInput} from './resources.mts';
export type {MaskIntervalOptions, MaskChiselOptions} from './masks.mts';
export type {ZoneEffects, ZoneApplication} from './zones.mts';
export type {GraphInspection, ExecutionNode, ExecutionEdge} from './inspect.mts';
export type {
  SampleContext, PixelFootprint, DomainSample,
  ScalarSample as ScalarEvaluation, ColorSample as ColorEvaluation,
} from './field-evaluate.mts';
export type {
  FieldInput, FieldSampler, FieldSamples, FieldSort, FieldRoot, FieldRoots, FieldOutputs,
} from './evaluate.mts';
export type {PigmentQuantity, PigmentOptions} from '../color/pigment.mts';
export type {PaintFieldOptions} from '../paint/data.mts';
export type {ManagedColorSpace, DisplayColorSpace, TaggedColor} from '../color/management.mts';
export type {
  MarkPoint, MarkTransform, MarkBounds, MarkBrushInput, MarkBrush, MarkZoneInput, MarkZone,
  DabMarkInput, DabMark, StrokePointInput, StrokePoint, StrokeMarkInput, StrokeMark,
  MarkInput, Mark, MarkProgramInput, MarkProgram,
} from '../paint/marks.mts';
export type {MarkBakeOptions, MarkBakeStats, MarkBake, CompiledMarkProgram} from '../paint/mark-raster.mts';
export type {MarkApplicationOptions} from '../paint/mark-apply.mts';
