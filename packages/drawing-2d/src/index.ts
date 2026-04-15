/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/drawing-2d
 *
 * 2D architectural drawing generation from IFC models.
 * Generates section cuts, floor plans, and elevations with:
 * - Cut lines (geometry intersected by section plane)
 * - Projection lines (visible geometry beyond cut)
 * - Hidden lines (occluded geometry, dashed)
 * - Silhouettes and feature edges
 * - Hatching (material-based fill patterns by IFC type)
 * - Vector output (SVG)
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type {
  // Vector types
  Vec2,
  Vec3,
  Point2D,
  Line2D,
  Polyline2D,
  Polygon2D,
  Bounds2D,

  // Configuration
  SectionAxis,
  SectionPlaneConfig,
  SectionConfig,

  // Line classification
  LineCategory,
  VisibilityState,

  // Drawing elements
  DrawingLine,
  DrawingPolygon,

  // Intermediate results
  CutSegment,
  MeshCutResult,
  SectionCutResult,

  // Complete output
  Drawing2D,

  // Edge data
  EdgeData,

  // Profile extraction
  ProfileEntry,

  // Utility types
  EntityKey,
} from './types.js';

export { DEFAULT_SECTION_CONFIG, makeEntityKey, parseEntityKey } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// SECTION CUTTING
// ═══════════════════════════════════════════════════════════════════════════

export { SectionCutter, cutMeshesStreaming } from './section-cutter.js';
export type { StreamingSectionCutterOptions } from './section-cutter.js';

// ═══════════════════════════════════════════════════════════════════════════
// POLYGON BUILDING
// ═══════════════════════════════════════════════════════════════════════════

export { PolygonBuilder, simplifyPolygon, polygonBounds } from './polygon-builder.js';

// ═══════════════════════════════════════════════════════════════════════════
// LINE MERGING
// ═══════════════════════════════════════════════════════════════════════════

export {
  mergeDrawingLines,
  mergeCollinearLines,
  deduplicateLines,
  splitLineAtParams,
} from './line-merger.js';
export type { LineMergerOptions } from './line-merger.js';

// ═══════════════════════════════════════════════════════════════════════════
// EDGE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

export { EdgeExtractor, getViewDirection } from './edge-extractor.js';

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE PROJECTION (clean silhouettes from WASM profiles)
// ═══════════════════════════════════════════════════════════════════════════

export { projectProfiles } from './profile-projector.js';

// ═══════════════════════════════════════════════════════════════════════════
// HIDDEN LINE REMOVAL
// ═══════════════════════════════════════════════════════════════════════════

export { HiddenLineClassifier } from './hidden-line.js';
export type { VisibilitySegment, VisibilityResult, HiddenLineOptions } from './hidden-line.js';

// ═══════════════════════════════════════════════════════════════════════════
// STYLES (HATCHING & LINE WEIGHTS)
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Hatch patterns
  HATCH_PATTERNS,
  getHatchPattern,

  // Line styles
  LINE_STYLES,
  TYPE_LINE_WEIGHTS,
  getLineStyle,

  // Scales
  COMMON_SCALES,
  getRecommendedScale,

  // Paper sizes
  PAPER_SIZES,
} from './styles.js';

export type {
  HatchPatternType,
  HatchPattern,
  LineStyle,
  DrawingScale,
  PaperSize,
} from './styles.js';

// ═══════════════════════════════════════════════════════════════════════════
// HATCH GENERATION
// ═══════════════════════════════════════════════════════════════════════════

export { HatchGenerator } from './hatch-generator.js';
export type { HatchLine, HatchResult, CustomHatchSettings } from './hatch-generator.js';

// ═══════════════════════════════════════════════════════════════════════════
// SVG EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export { SVGExporter, exportToSVG } from './svg-exporter.js';
export type { SVGExportOptions } from './svg-exporter.js';

// ═══════════════════════════════════════════════════════════════════════════
// GPU ACCELERATION
// ═══════════════════════════════════════════════════════════════════════════

export { GPUSectionCutter, isGPUComputeAvailable } from './gpu-section-cutter.js';

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL GENERATOR
// ═══════════════════════════════════════════════════════════════════════════

export {
  Drawing2DGenerator,
  createSectionConfig,
  generateFloorPlan,
  generateSection,
} from './drawing-generator.js';
export type { GeneratorOptions, GeneratorProgress } from './drawing-generator.js';

// ═══════════════════════════════════════════════════════════════════════════
// MATH UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Constants
  EPSILON,

  // Vec3 operations
  vec3,
  vec3Add,
  vec3Sub,
  vec3Scale,
  vec3Dot,
  vec3Cross,
  vec3Length,
  vec3Normalize,
  vec3Lerp,
  vec3Equals,
  vec3Distance,

  // Point2D operations
  point2D,
  point2DAdd,
  point2DSub,
  point2DScale,
  point2DDot,
  point2DLength,
  point2DDistance,
  point2DLerp,
  point2DEquals,
  point2DNormalize,
  point2DCross,

  // Line operations
  lineLength,
  lineMidpoint,
  lineDirection,
  linesCollinear,
  projectPointOnLine,

  // Bounds operations
  boundsEmpty,
  boundsExtendPoint,
  boundsExtendLine,
  boundsCenter,
  boundsSize,
  boundsValid,

  // Plane operations
  signedDistanceToPlane,
  getAxisNormal,
  getProjectionAxes,
  projectTo2D,

  // Polygon operations
  polygonSignedArea,
  isCounterClockwise,
  reversePolygon,
  ensureCCW,
  ensureCW,
} from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// OPENING HANDLING
// ═══════════════════════════════════════════════════════════════════════════

export {
  OpeningRelationshipBuilder,
  OpeningFilter,
  buildOpeningRelationships,
  getOpeningsForHost,
  getFillingElement,
  isOpeningElement,
  isDoorOrWindow,
} from './openings/index.js';

export type {
  // Opening types
  OpeningInfo,
  OpeningRelationships,
  VoidRelationship,
  FillRelationship,
  DoorOperationType,
  WindowPartitioningType,
  EntityMetadata,
  DrawingContext,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURAL SYMBOLS
// ═══════════════════════════════════════════════════════════════════════════

export {
  DoorSymbolGenerator,
  WindowSymbolGenerator,
  SymbolRenderer,
  generateDoorSymbol,
  generateWindowSymbol,
  generateStairArrow,
} from './symbols/index.js';

export type {
  // Symbol types
  ArchitecturalSymbol,
  SymbolType,
  SymbolParameters,
  DoorSwingParameters,
  SlidingDoorParameters,
  WindowFrameParameters,
  StairArrowParameters,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// LINE STYLING & LAYERS
// ═══════════════════════════════════════════════════════════════════════════

export {
  LineWeightAssigner,
  LINE_WEIGHT_CONFIG,
  IFC_TYPE_WEIGHTS,
  LineStyler,
  DASH_PATTERNS,
  LayerMapper,
  DEFAULT_LAYERS,
  getLayerForIfcType,
} from './styling/index.js';

export type {
  // Styling types
  ArchitecturalLine,
  LineWeight,
  LineWeightConfig,
  SemanticLineType,
  LayerDefinition,
  AIALayerCode,
  ArchitecturalDrawing2D,
} from './types.js';

// Re-export LineStyle from types (note: this shadows the style module's LineStyle)
export type { LineStyle as ArchitecturalLineStyle } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// OBJECT STYLES (Revit-like per-category graphic configuration)
// ═══════════════════════════════════════════════════════════════════════════

export {
  DEFAULT_OBJECT_STYLES,
  LINE_PATTERN_DASH_ARRAYS,
  resolveObjectStyle,
  isIfcTypeVisible,
  getHiddenIfcTypes,
} from './object-styles.js';

export type {
  LinePatternPreset,
  ObjectStyleLineProps,
  ObjectStyleHatch,
  ObjectStyle,
  ObjectStylesConfig,
  ObjectStyleOverride,
  ObjectStyleOverrides,
} from './object-styles.js';

// ═══════════════════════════════════════════════════════════════════════════
// GRAPHIC OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Engine
  GraphicOverrideEngine,
  createOverrideEngine,

  // Criteria helpers
  ifcTypeCriterion,
  propertyCriterion,
  andCriteria,
  orCriteria,

  // Built-in presets
  BUILT_IN_PRESETS,
  VIEW_3D_PRESET,
  ARCHITECTURAL_PRESET,
  FIRE_SAFETY_PRESET,
  STRUCTURAL_PRESET,
  MEP_PRESET,
  MONOCHROME_PRESET,
  getBuiltInPreset,
  getPresetsByCategory,
} from './graphic-overrides/index.js';

export type {
  // Override types
  LineWeightPreset,
  LineStylePreset,
  DashPattern,
  CriteriaOperator,
  CriteriaType,
  OverrideCriterion,
  OverrideCriteria,
  GraphicStyle,
  GraphicOverrideRule,
  GraphicOverridePreset,
  ElementData,
  ResolvedGraphicStyle,
  OverrideResult,
} from './graphic-overrides/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// DRAWING SHEETS (Paper, Frames, Title Blocks, Scale Bars)
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Paper sizes
  PAPER_SIZE_REGISTRY,
  getPaperSizesByCategory,
  getDefaultPaperSize,

  // Frames
  FRAME_PRESETS,
  createFrame,
  getDefaultFrame,

  // Title blocks
  DEFAULT_TITLE_BLOCK_FIELDS,
  TITLE_BLOCK_PRESETS,
  createTitleBlock,
  getDefaultTitleBlock,
  updateTitleBlockField,

  // Scale bar
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  calculateOptimalScaleBarLength,
  calculateOptimalDivisions,

  // Sheet utilities
  calculateViewportBounds,
  calculateDrawingTransform,

  // Sheet renderers
  renderFrame,
  renderTitleBlock,
  renderScaleBar,
  renderNorthArrow,
} from './sheet/index.js';

export type {
  // Paper types
  PaperOrientation,
  PaperSizeCategory,
  PaperSizeDefinition,

  // Frame types
  FrameStyle,
  FrameBorderConfig,
  FrameMargins,
  DrawingFrame,

  // Title block types
  TitleBlockPosition,
  TitleBlockLayout,
  TitleBlockField,
  TitleBlockLogo,
  RevisionEntry,
  TitleBlockConfig,

  // Scale bar types
  ScaleBarStyle,
  ScaleBarPosition,
  ScaleBarUnits,
  ScaleBarConfig,
  NorthArrowStyle,
  NorthArrowConfig,

  // Sheet types
  ViewportBounds,
  DrawingSheet,
  SheetCreationOptions,

  // Renderer types
  FrameRenderResult,
  FrameInnerBounds,
  TitleBlockRenderResult,
  TitleBlockExtras,
  PositionMm,
} from './sheet/index.js';
