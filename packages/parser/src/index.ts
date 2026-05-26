/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/parser - Main parser interface
 * Supports both IFC4 (STEP) and IFC5 (IFCX/JSON) formats
 */

export { StepTokenizer } from './tokenizer.js';
export { EntityIndexBuilder } from './entity-index.js';
export { EntityExtractor } from './entity-extractor.js';
export { CompactEntityIndex, CompactEntityIndexBuilder, buildCompactEntityIndex } from './compact-entity-index.js';
export type { EntityScanPath, EntityScanResult, PreScannedEntityIndex, WasmScanApi } from './entity-scanner.js';
export { OpfsSourceBuffer } from './opfs-source-buffer.js';
export { PropertyExtractor } from './property-extractor.js';
export { QuantityExtractor } from './quantity-extractor.js';
export { RelationshipExtractor } from './relationship-extractor.js';
export { StyleExtractor } from './style-extractor.js';
export { SpatialHierarchyBuilder } from './spatial-hierarchy-builder.js';
export { extractLengthUnitScale } from './unit-extractor.js';
export { ColumnarParser, type IfcDataStore, type EntityByIdIndex, extractPropertiesOnDemand, extractQuantitiesOnDemand, extractEntityAttributesOnDemand, extractAllEntityAttributes, extractClassificationsOnDemand, extractMaterialsOnDemand, extractTypePropertiesOnDemand, extractTypeEntityOwnProperties, extractDocumentsOnDemand, extractRelationshipsOnDemand, extractGeoreferencingOnDemand, type ClassificationInfo, type MaterialInfo, type MaterialLayerInfo, type MaterialProfileInfo, type MaterialConstituentInfo, type TypePropertyInfo, type DocumentInfo, type EntityRelationships } from './columnar-parser.js';
// WorkerParser is browser-only due to Vite worker imports
// Import from '@ifc-lite/parser/browser' instead

// IFC5 (IFCX) support - re-export from @ifc-lite/ifcx
export {
  parseIfcx,
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
  type ComposedNodeWithSources,
  type IfcxLayer,
  type LayerStack,
  type PathIndex,
  type MeshData as IfcxMeshData,
  type PointCloudExtraction,
} from '@ifc-lite/ifcx';

// New extractors with 100% schema coverage
export { extractMaterials, getMaterialForElement, getMaterialNameForElement, type MaterialsData, type Material, type MaterialLayer, type MaterialLayerSet } from './material-extractor.js';
export { extractGeoreferencing, transformToWorld, transformToLocal, getCoordinateSystemDescription, computeAngleToGridNorth, type GeoreferenceInfo, type MapConversion, type ProjectedCRS } from './georef-extractor.js';
export { extractClassifications, getClassificationsForElement, getClassificationCodeForElement, getClassificationPath, groupElementsByClassification, type ClassificationsData, type Classification, type ClassificationReference } from './classification-extractor.js';

// 4D / scheduling extractor — IfcTask, IfcTaskTime, IfcRelSequence, IfcRelAssignsToProcess,
// IfcRelAssignsToControl, IfcRelNests, IfcWorkSchedule, IfcWorkPlan, IfcLagTime.
export {
  extractScheduleOnDemand,
  parseIso8601Duration,
  type ScheduleExtraction,
  type ScheduleTaskInfo,
  type ScheduleTaskTimeInfo,
  type ScheduleSequenceInfo,
  type WorkScheduleInfo,
  type SequenceTypeEnum,
  type TaskDurationType,
} from './schedule-extractor.js';

// IFC4 STEP serializer for schedule entities — produces ready-to-splice
// `#N=IFC...(...)` lines from a `ScheduleExtraction`.
export {
  serializeScheduleToStep,
  type SerializeScheduleOptions,
  type SerializeScheduleResult,
} from './schedule-serializer.js';

// Deterministic 22-char GlobalId generator — shared by every call site
// that mints a synthetic IFC-style id (serializer fallback, schedule
// generator, user-authored tasks). Never re-implement this; always
// import from here.
export { deterministicGlobalId } from './deterministic-global-id.js';

// Generated IFC4 schema (100% coverage - 776 entities, 397 types, 207 enums)
export { SCHEMA_REGISTRY, getEntityMetadata, getAllAttributesForEntity, getInheritanceChainForEntity, isKnownEntity } from './generated/schema-registry.js';
export type * from './generated/entities.js';
export * from './generated/enums.js';

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
export * from './style-extractor.js';
export { getAttributeNames, getAttributeNameAt, isKnownType, normalizeIfcTypeName } from './ifc-schema.js';

import type { IfcEntity, ParseResult } from './types.js';
import { EntityIndexBuilder } from './entity-index.js';
import { EntityExtractor } from './entity-extractor.js';
import { PropertyExtractor } from './property-extractor.js';
import { RelationshipExtractor } from './relationship-extractor.js';
import { ColumnarParser, type IfcDataStore } from './columnar-parser.js';
import { scanIfcEntities, type PreScannedEntityIndex, type WasmScanApi } from './entity-scanner.js';

export interface ParseOptions {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onDiagnostic?: (message: string) => void;
  wasmApi?: WasmScanApi; // Optional IfcAPI instance for WASM-accelerated entity scanning
  /** Yield budget for large incremental parses. Higher values finish faster with longer main-thread slices. */
  yieldIntervalMs?: number;
  /** Keep property-set containers in the primary index but defer indexing individual property/quantity atoms. */
  deferPropertyAtomIndex?: boolean;
  /** Skip worker-based entity scanning and stay in-process. Useful for huge buffers already loaded on the main thread. */
  disableWorkerScan?: boolean;
  /** Called when spatial hierarchy is ready, BEFORE property/association parsing completes.
   *  Use this to show the hierarchy panel early while the full parse finishes. */
  onSpatialReady?: (partialStore: import('./columnar-parser.js').IfcDataStore) => void;
  /**
   * Pre-built entity index from another worker (typically the streaming
   * geometry pre-pass). When supplied, `parseColumnar` skips both the
   * worker-based and WASM scans and synthesizes `EntityRef[]` from the
   * column arrays directly — saving ~10 s on 1 GB / 14 M-entity files
   * where the parser would otherwise duplicate the pre-pass scan under
   * heavy WASM contention with the geometry workers.
   */
  preScannedEntityIndex?: PreScannedEntityIndex;
}

/**
 * Main parser class
 */
export class IfcParser {
  /**
   * Parse IFC file into the legacy eager ParseResult shape.
   *
   * @deprecated Prefer parseColumnar() for new code. This method is kept as a
   * compatibility adapter and reuses the shared scanner before eager extraction.
   */
  async parse(buffer: ArrayBuffer, options: ParseOptions = {}): Promise<ParseResult> {
    const uint8Buffer = new Uint8Array(buffer);

    // Phase 1: Scan for entities
    options.onProgress?.({ phase: 'scan', percent: 0 });
    const { entityRefs } = await scanIfcEntities(buffer, {
      ...options,
      onProgress: undefined,
      onDiagnostic: undefined,
    });
    const indexBuilder = new EntityIndexBuilder();
    for (const ref of entityRefs) indexBuilder.addEntity(ref);

    const entityIndex = indexBuilder.build();
    options.onProgress?.({ phase: 'scan', percent: 100 });

    // Phase 2: Extract entities
    options.onProgress?.({ phase: 'extract', percent: 0 });
    const extractor = new EntityExtractor(uint8Buffer);
    const entities = new Map<number, IfcEntity>();

    for (let i = 0; i < entityRefs.length; i++) {
      const ref = entityRefs[i];
      const entity = extractor.extractEntity(ref);
      if (entity) {
        entities.set(ref.expressId, entity);
      }
      if ((i + 1) % 1000 === 0) {
        options.onProgress?.({ phase: 'extract', percent: ((i + 1) / entityRefs.length) * 100 });
      }
    }

    options.onProgress?.({ phase: 'extract', percent: 100 });

    // Phase 3: Extract properties
    options.onProgress?.({ phase: 'properties', percent: 0 });
    const propertyExtractor = new PropertyExtractor(entities);
    const propertySets = propertyExtractor.extractPropertySets();
    options.onProgress?.({ phase: 'properties', percent: 100 });

    // Phase 4: Extract relationships
    options.onProgress?.({ phase: 'relationships', percent: 0 });
    const relationshipExtractor = new RelationshipExtractor(entities);
    const relationships = relationshipExtractor.extractRelationships();
    options.onProgress?.({ phase: 'relationships', percent: 100 });

    return {
      entities,
      propertySets,
      relationships,
      entityIndex,
      fileSize: buffer.byteLength,
      entityCount: entities.size,
    };
  }
  
  /**
   * Parse IFC file into columnar data store
   *
   * Uses fast scan + on-demand property extraction for all files.
   * Properties are extracted lazily when accessed, not upfront.
   *
   * Accepts both `ArrayBuffer` and `SharedArrayBuffer`. The
   * cross-worker SAB path (parser worker) passes the latter; the
   * in-process path passes a regular ArrayBuffer.
   */
  async parseColumnar(
    buffer: ArrayBuffer | SharedArrayBuffer,
    options: ParseOptions = {},
  ): Promise<IfcDataStore> {
    const { entityRefs, processed, elapsedMs, scanPath } = await scanIfcEntities(buffer, options);
    console.log(`[IfcParser] Fast scan: ${processed} entities in ${elapsedMs.toFixed(0)}ms (path=${scanPath})`);

    // Build columnar structures with on-demand property extraction
    const columnarParser = new ColumnarParser();
    const dataStore = await columnarParser.parseLite(buffer, entityRefs, options);
    return dataStore;
  }
}

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
