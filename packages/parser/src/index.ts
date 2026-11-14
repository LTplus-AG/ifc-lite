/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * @ifc-lite/parser - Main parser interface
 * Supports both IFC4 (STEP) and IFC5 (IFCX/JSON) formats
 */

export { parseModel, IfcInputError, validateStepInput } from './parse-model.js';
export type { ParseModelOptions, ParsedModel, IfcInputErrorCode } from './parse-model.js';
export type { EntityScanReport, ScanDiagnostic, ScanCompleteness } from './scan-report.js';
import { unwrapIfcZip } from './ifczip.js';
// `unwrapIfcZip` unwraps an ArrayBuffer (no-op for non-zip); `unwrapIfcZipView`
// is the same for Node Buffer/Uint8Array callers (CLI/MCP loaders). The
// magic-byte predicate `isZipBuffer` stays internal to `./ifczip.js` — no
// external consumer needs to know WHETHER a buffer was a zip, only to get the
// unwrapped bytes back.
export { unwrapIfcZip, unwrapIfcZipView, unwrapIfcZipWithResources } from './ifczip.js';
export type { IfcZipContents } from './ifczip.js';
export { StepTokenizer } from './tokenizer.js';
export { EntityIndexBuilder } from './entity-index.js';
export { EntityExtractor } from './entity-extractor.js';
export { spatialContainerPath, authoredKeyValue, parseAuthoredKeySpec, type AuthoredKeySpec } from './identity-hints.js';
export { STEP_TRIVIA } from './step-trivia.js';
// The source accessor (#2183). Exported because the byte-range readers in
// @ifc-lite/export, @ifc-lite/cli and the viewer now accept either shape, and
// `IfcDataStore.source` is on its way to this type — so it is public surface
// either way. The producers are exported too now that `IfcDataStore.source` IS
// this type: anything constructing a store needs to say "wrap these bytes"
// (`contiguousSourceBytes`) or "this model has none" (`EMPTY_SOURCE_BYTES`),
// and the server-parsed, synthetic, GLB and point-cloud paths all do.
export {
  asSourceBytes,
  contiguousSourceBytes,
  isSourceBytes,
  sourceBytesFromTransferable,
  compressSourceInPlace,
  sourceBlockStats,
  EMPTY_SOURCE_BYTES,
} from './source-bytes.js';
export {
  compressSource,
  shouldCompressSource,
  COMPRESSION_MIN_BYTES,
  type CompressedSource,
} from './source-compress.js';
export {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_CACHE_BYTES,
  type BlockedPayload,
  type BlockStoreCounters,
} from './block-store.js';
export type { IfcSourceBytes, IfcSourceTransfer } from './source-bytes.js';
export { CompactEntityIndex, CompactEntityIndexBuilder, buildCompactEntityIndex } from './compact-entity-index.js';
export { scanIfcEntities } from './entity-scanner.js';
export type { EntityScanPath, EntityScanResult, PreScannedEntityIndex, WasmScanApi } from './entity-scanner.js';
export { REL_TYPE_MAP, SECONDARY_REL_TYPE_MAP, isIfcTypeLikeEntity } from './columnar-parser-indexes.js';
export { IFC_SUBTYPES, expandTypes, QUERY_REL_TYPE_MAP } from './query-backend-maps.js';
export { PropertyExtractor } from './property-extractor.js';
export { QuantityExtractor } from './quantity-extractor.js';
export { RelationshipExtractor } from './relationship-extractor.js';
export { propertyDefinitionRefsOfValue } from './property-definition-refs.js';
export { propertyDefinitionsInModel } from './property-definition-members.js';
export { SpatialHierarchyBuilder } from './spatial-hierarchy-builder.js';
export {
  SI_PREFIX_MULTIPLIERS, extractLengthUnitScale, declareLengthUnitScale,
  resolveEntityLengthUnitScale,
  resolveOwningIfcProjectId,
  type LengthUnitSource,
} from './unit-extractor.js';
export {
  extractProjectUnits,
  measureUnit,
  ProjectUnits,
  type ResolvedUnit,
  type MeasureUnit,
} from './project-units.js';
export { quantitySiScale } from './quantity-collect.js';
export { scaleMeasureValue, scaledPropertyValue, roundToScale } from './measure-unit-scale.js';
export { ColumnarParser, type IfcDataStore, type EntityByIdIndex, extractPropertiesOnDemand, extractQuantitiesOnDemand, extractEntityAttributesOnDemand, extractAllEntityAttributes, getRawNamedAttributes, extractRootAttributesFromEntity, extractClassificationsOnDemand, extractClassificationSystemsOnDemand, extractMaterialsOnDemand, extractAllMaterialsOnDemand, extractMaterialPropertiesOnDemand, extractMaterialPropertiesForMaterialId, resolveMaterialDefId, resolveAllMaterialDefIds, collectMaterialLeaves, buildMaterialUsageIndex, getMaterialDisplay, extractTypePropertiesOnDemand, extractTypeEntityOwnProperties, extractTypeQuantitiesOnDemand, extractTypeEntityOwnQuantities, mergeInheritedPropertySets, mergeInheritedQuantitySets, extractDocumentsOnDemand, extractRelationshipsOnDemand, extractExactRelatedIds, extractGroupMembersOnDemand, extractGroupAssignmentFactorOnDemand, extractGeoreferencingOnDemand, type ClassificationInfo, type ClassificationSystemNames, type MaterialInfo, type MaterialLayerInfo, type MaterialProfileInfo, type MaterialConstituentInfo, type MaterialPsetGroup, type MaterialLeaf, type MaterialUsage, type TypePropertyInfo, type TypeQuantityInfo, type DocumentInfo, type EntityRelationships, type GroupMember } from './columnar-parser.js';
export { OccurrenceQuantityReadError } from './occurrence-quantity-read-error.js';
export type { MaterialPropertiesView } from './on-demand-extractors.js';
export type { IfcStoreBase, IfcSourceHeader, SpatialHierarchy, EntityTable } from '@ifc-lite/data';
export { parseSourceHeader } from './source-header.js';
export type { ExtractedProperty } from './property-value-parser.js';
export { COMPLEX_PROPERTY_BUDGET_MARKER } from './property-complex-value.js';
export { complexPropertyCuts } from './complex-property-store.js';
export { attachDataStoreAccessors, type IfcStoreData } from './data-store-accessors.js';
export { buildDropCensus, type DropCensus, type DropCensusInput, type ClassCensusEntry, type DropCategory } from './drop-census.js';
export { createSyntheticDataStore, type SyntheticDataStoreOptions, type SyntheticEntity } from './synthetic-data-store.js';
// WorkerParser is browser-only due to Vite worker imports
// Import from '@ifc-lite/parser/browser' instead

// IFC5 (IFCX) support - re-export from @ifc-lite/ifcx
export {
  parseIfcx, IFCX_LENGTH_UNIT_SCALE,
  parseFederatedIfcx,
  addIfcxOverlay,
  detectFormat,
  composeIfcx,
  composeFederated,
  createLayerStack,
  createPathIndex,
  parsePath,
  type IfcxParseResult,
  type FederatedIfcxParseResult,
  type FederatedFileInput,
  type FederatedParseOptions,
  type IfcxFile,
  type IfcxNode,
  type ComposedNode,
  type ComposedNodeWithSources, findDivergentAttributes, type AttributeOpinion, type AttributeOpinions, type DivergentAttribute,
  type IfcxLayer,
  type LayerStack,
  type PathIndex,
  type MeshData as IfcxMeshData,
  type PointCloudExtraction,
} from '@ifc-lite/ifcx';
// New extractors with 100% schema coverage
export { extractMaterials, getMaterialForElement, getMaterialNameForElement, type MaterialsData, type Material, type MaterialLayer, type MaterialLayerSet } from './material-extractor.js';
export { materialAssignmentsAvailable } from './material-overlay.js';
export { extractGeoreferencing, computeTransformMatrix, transformToWorld, transformToLocal, getCoordinateSystemDescription, computeAngleToGridNorth, type GeoreferenceInfo, type MapConversion, type ProjectedCRS } from './georef-extractor.js';
export { extractClassifications, getClassificationsForElement, getClassificationCodeForElement, getClassificationPath, groupElementsByClassification, type ClassificationsData, type Classification, type ClassificationReference } from './classification-extractor.js';

// 4D scheduling extractor: tasks, sequences, schedules, calendars and recurrence data.
export {
  extractScheduleOnDemand,
  parseIso8601Duration, taskProductExpressIds, taskProductGlobalIds,
  type ScheduleExtraction,
  type ScheduleTaskInfo,
  type ScheduleTaskTimeInfo,
  type ScheduleSequenceInfo,
  type WorkScheduleInfo,
  type WorkCalendarInfo, type WorkTimeInfo, type RecurrencePatternInfo, type TimePeriodInfo,
  type SequenceTypeEnum,
  type TaskDurationType,
} from './schedule-extractor.js';

// Structural analysis extractor: IfcStructuralAnalysisModel, the member,
// connection and activity branches, load and result groups,
// IfcBoundaryCondition, the structural connects-relationships and the
// physical-to-analytical links, their counterpart lookup and consistency checks.
export {
  extractStructuralOnDemand,
  type StructuralExtraction,
  type StructuralAnalysisModelInfo,
  type StructuralMemberInfo,
  type StructuralConnectionInfo,
  type StructuralActivityInfo,
  type StructuralLoadGroupInfo,
  type StructuralResultGroupInfo,
  type StructuralLoadInfo, type StructuralLoadConfigurationInfo, type StructuralLoadConfigurationEntry,
  type StructuralLoadDropReason,
  type StructuralExtractionView,
  type BoundaryConditionInfo,
} from './structural-extractor.js';
export { structuralCounterparts, type StructuralCounterparts } from './structural-counterparts.js';
export { DEFAULT_AXIS_DRIFT_TOLERANCE, DEFAULT_STALE_TOLERANCE, DERIVATION_AXIS_PROPERTIES, DERIVATION_ELEMENT_PROPERTY, STRUCTURAL_DERIVATION_PSET, type StructuralConsistencyIssue, type StructuralConsistencyOptions, type StructuralConsistencyRule, type StructuralLine } from './structural-consistency.js';
export { structuralConsistencyIssues, type StructuralConsistencyIssuesOptions } from './structural-consistency-facts.js';

// IFC4 STEP serializer for schedule entities — produces ready-to-splice
// `#N=IFC...(...)` lines from a `ScheduleExtraction`.
export {
  serializeScheduleToStep,
  type SerializeScheduleOptions,
  type SerializeScheduleResult,
} from './schedule-serializer.js';

// Cost (5D) extractor — IfcCostItem, IfcCostValue, IfcCostSchedule, IfcRelNests,
// IfcRelAssignsToControl. Read model + extraction only (#4322).
export * from './cost.js';

// Signed ISO 8601 duration codec — shared by the schedule extractor (decode)
// and serializer (encode), and by any other schedule consumer that needs to
// go from seconds to an `IfcDuration` string or back. See the module doc
// comment for the signed-duration interop tradeoff.
export { secondsToIso8601Duration } from './iso8601-duration.js';

// Deterministic 22-char GlobalId generator — shared by every call site
// that mints a synthetic IFC-style id (serializer fallback, schedule
// generator, user-authored tasks). Never re-implement this; always
// import from here.
export { deterministicGlobalId } from './deterministic-global-id.js';

export * from './schema-exports.js';

// STEP serialization support for IFC export
export {
  serializeValue,
  toStepLine,
  generateHeader,
  generateStepFile,
  parseStepValue,
  ref,
  enumVal,
  isEntityRef,
  isEnumValue,
  type StepValue,
  type StepEntity,
  type EntityRef as StepEntityRef,
  type EnumValue,
} from './generated/serializers.js';

export * from './types.js';
// `getInheritanceChainAcrossSchemas` is the counterpart of
// `getAttributeNamesAcrossSchemas`: it answers for every bundled schema
// (IFC2X3 + IFC4 + IFC4X3), where the generated `getInheritanceChainForEntity`
// above only knows the codegen pin (IFC4_ADD2_TC1) and returns an empty chain
// for a class the pin does not carry — `IfcMove`, `IfcSpaceProgram`, `IfcRoad`.
// Anything that decides *what kind of thing* an entity is must use this one.
// `isKnownType` and `normalizeIfcTypeName` are cross-schema too, despite the
// unqualified names — they were pin-only until #2003.
//
// NAMING FOOTGUN, recorded rather than fixed here: the pinned helper has the
// shorter, more obvious name (`getInheritanceChainForEntity`) and the correct
// one carries the qualifier, so reaching for the wrong one is the path of least
// resistance — five call sites have now been fixed after the fact (#2001, #2003,
// #2014, this one). The qualifier belongs on the *pinned* function
// (`…ForEntityInIfc4Pin`), leaving the union walker the plain name, so the easy
// choice is the safe one. That is a rename across every consumer and does not
// belong in a fix PR; it needs its own.
export { getAttributeNames, getAttributeNamesAcrossSchemas, getAttributeNamesForSchema, getAttributeTypeForSchema, getAttributeNameAt, isKnownType, isInstantiable, isQueryableObjectType, normalizeIfcTypeName, resolveEntityNameAlias, getInheritanceChain as getInheritanceChainAcrossSchemas } from './ifc-schema.js';
export * from './native-metadata-public.js';
export { IfcParser, type ParseOptions } from './ifc-parser.js';
import { IfcParser, type ParseOptions } from './ifc-parser.js';
import type { IfcDataStore } from './columnar-parser.js';

// Import for auto-parser
import { parseIfcx, detectFormat, type IfcxParseResult, type MeshData as IfcxMeshData } from '@ifc-lite/ifcx';

/**
 * Result type for auto-parsing (union of IFC4 and IFC5 results)
 */
export type AutoParseResult = {
  format: 'ifc';
  data: IfcDataStore;
  meshes?: undefined;
} | {
  format: 'ifcx';
  data: IfcxParseResult;
  meshes: IfcxMeshData[];
};

/**
 * Auto-detect file format and parse accordingly.
 * Returns unified result with format indicator.
 */
export async function parseAuto(
  buffer: ArrayBuffer,
  options: ParseOptions = {}
): Promise<AutoParseResult> {
  // Transparent .ifcZIP unwrap (issue #1494): a no-op for every ordinary
  // IFC/IFCX/GLB buffer (cheap magic-byte check), so this is safe to run
  // unconditionally.
  buffer = await unwrapIfcZip(buffer);
  const format = detectFormat(buffer);

  if (format === 'ifcx') {
    const result = await parseIfcx(buffer, options);
    return {
      format: 'ifcx',
      data: result,
      meshes: result.meshes,
    };
  }

  if (format === 'ifc') {
    const parser = new IfcParser();
    const data = await parser.parseColumnar(buffer, options);
    return {
      format: 'ifc',
      data,
    };
  }

  throw new Error('Unknown file format. Expected IFC (STEP) or IFCX (JSON).');
}

export { findSourceProjectLengthUnit, normalizeMapUnitName } from './source-project-length-unit.js';
export { WASM_SOURCE_BYTE_LIMIT, WasmSourceSizeError, assertWasmSourceSize } from './wasm-source-limit.js';
