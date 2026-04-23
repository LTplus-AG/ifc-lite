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
export { getAttributeNames, getAttributeNameAt, isKnownType } from './ifc-schema.js';

import type { ParseResult, EntityRef } from './types.js';
import { decodeIfcString } from '@ifc-lite/encoding';
import { StepTokenizer } from './tokenizer.js';
import { EntityIndexBuilder } from './entity-index.js';
import { EntityExtractor } from './entity-extractor.js';
import { PropertyExtractor } from './property-extractor.js';
import { RelationshipExtractor } from './relationship-extractor.js';
import { ColumnarParser, type IfcDataStore } from './columnar-parser.js';
import { scanEntitiesInWorker } from './scan-worker-inline.js';

export interface ParseOptions {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onDiagnostic?: (message: string) => void;
  wasmApi?: any; // Optional IfcAPI instance for WASM-accelerated entity scanning
  /** Yield budget for large incremental parses. Higher values finish faster with longer main-thread slices. */
  yieldIntervalMs?: number;
  /** Keep property-set containers in the primary index but defer indexing individual property/quantity atoms. */
  deferPropertyAtomIndex?: boolean;
  /** Skip worker-based entity scanning and stay in-process. Useful for huge buffers already loaded on the main thread. */
  disableWorkerScan?: boolean;
  /** Called when spatial hierarchy is ready, BEFORE property/association parsing completes.
   *  Use this to show the hierarchy panel early while the full parse finishes. */
  onSpatialReady?: (partialStore: import('./columnar-parser.js').IfcDataStore) => void;
}

/**
 * Main parser class
 */
export class IfcParser {
  /**
   * Parse IFC file into structured data
   */
  async parse(buffer: ArrayBuffer, options: ParseOptions = {}): Promise<ParseResult> {
    const uint8Buffer = new Uint8Array(buffer);

    // Phase 1: Scan for entities
    options.onProgress?.({ phase: 'scan', percent: 0 });
    const tokenizer = new StepTokenizer(uint8Buffer);
    const indexBuilder = new EntityIndexBuilder();

    let scanned = 0;
    const entityRefs: EntityRef[] = [];

    for (const ref of tokenizer.scanEntities()) {
      indexBuilder.addEntity({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
      scanned++;
    }

    const entityIndex = indexBuilder.build();
    options.onProgress?.({ phase: 'scan', percent: 100 });

    // Phase 2: Extract entities
    options.onProgress?.({ phase: 'extract', percent: 0 });
    const extractor = new EntityExtractor(uint8Buffer);
    const entities = new Map<number, any>();

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
   */
  async parseColumnar(buffer: ArrayBuffer, options: ParseOptions = {}): Promise<IfcDataStore> {
    const uint8Buffer = new Uint8Array(buffer);
    const fileSizeMB = buffer.byteLength / (1024 * 1024);

    // Fast scan: prefer Web Worker (non-blocking), fall back to main-thread scanners
    options.onProgress?.({ phase: 'scanning', percent: 0 });
    const scanStartTime = performance.now();

    let entityRefs: EntityRef[] = [];
    let processed = 0;

    // Try Web Worker scanner first (keeps main thread free for UI + geometry)
    if (!options.disableWorkerScan && typeof Worker !== 'undefined') {
      try {
        entityRefs = await scanEntitiesInWorker(buffer);
        processed = entityRefs.length;
      } catch (error) {
        console.warn('[IfcParser] Worker scan failed, falling back to main thread:', error);
        entityRefs.length = 0;
        processed = 0;
      }
    }

    // Fallback: WASM scanner (synchronous, blocks main thread)
    if (entityRefs.length === 0 && options.wasmApi && typeof options.wasmApi.scanEntitiesFast === 'function') {
      try {
        const scanFn = typeof options.wasmApi.scanRelevantEntitiesFastBytes === 'function'
          ? () => options.wasmApi!.scanRelevantEntitiesFastBytes(uint8Buffer)
          : typeof options.wasmApi.scanEntitiesFastBytes === 'function'
          ? () => options.wasmApi!.scanEntitiesFastBytes(uint8Buffer)
          : () => {
              const decoder = new TextDecoder();
              const content = decoder.decode(buffer);
              return options.wasmApi!.scanEntitiesFast(content);
            };
        const wasmRefs = scanFn() as Array<{
          expressId?: number;
          type?: string;
          byteOffset?: number;
          byteLength?: number;
          lineNumber?: number;
          express_id?: number;
          entity_type?: string;
          byte_offset?: number;
          byte_length?: number;
          line_number?: number;
        }>;

        if (wasmRefs.length > 0 && typeof wasmRefs[0]?.expressId === 'number') {
          entityRefs = wasmRefs as EntityRef[];
        } else {
          entityRefs = wasmRefs.map((ref) => ({
            expressId: ref.expressId ?? ref.express_id ?? 0,
            type: ref.type ?? ref.entity_type ?? '',
            byteOffset: ref.byteOffset ?? ref.byte_offset ?? 0,
            byteLength: ref.byteLength ?? ref.byte_length ?? 0,
            lineNumber: ref.lineNumber ?? ref.line_number ?? 0,
          }));
        }

        processed = entityRefs.length;
      } catch (error) {
        console.warn('[IfcParser] WASM scan failed, falling back to TypeScript:', error);
        entityRefs.length = 0;
        processed = 0;
      }
    }

    // Last resort: TypeScript scanner (yields to avoid blocking)
    if (entityRefs.length === 0) {
      const tokenizer = new StepTokenizer(uint8Buffer);
      const YIELD_INTERVAL = 5000;
      const estimatedTotalEntities = Math.max(fileSizeMB * 13500, 10000);

      for (const ref of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
          expressId: ref.expressId,
          type: ref.type,
          byteOffset: ref.offset,
          byteLength: ref.length,
          lineNumber: ref.line,
        });

        processed++;
        if (processed % YIELD_INTERVAL === 0) {
          const scanPercent = Math.min(95, (processed / estimatedTotalEntities) * 95);
          options.onProgress?.({ phase: 'scanning', percent: scanPercent });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }

    const scanElapsedMs = performance.now() - scanStartTime;
    console.log(`[IfcParser] Fast scan: ${processed} entities in ${scanElapsedMs.toFixed(0)}ms`);
    options.onDiagnostic?.(`scan complete: entities=${processed} elapsed=${scanElapsedMs.toFixed(0)}ms`);
    options.onProgress?.({ phase: 'scanning', percent: 100 });

    // Build columnar structures with on-demand property extraction
    const columnarParser = new ColumnarParser();
    const dataStore = await columnarParser.parseLite(buffer, entityRefs, options);
    return dataStore;
  }
}

/**
 * On-demand entity parser for lite mode
 * Parse a single entity's attributes from the source buffer
 */
export function parseEntityOnDemand(
  source: Uint8Array,
  entityRef: EntityRef
): { expressId: number; type: string; attributes: any[] } | null {
  try {
    const entityText = new TextDecoder().decode(
      source.subarray(entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength)
    );

    // Parse: #ID = TYPE(attr1, attr2, ...)
    const match = entityText.match(/^#(\d+)\s*=\s*(\w+)\((.*)\)/);
    if (!match) return null;

    const expressId = parseInt(match[1], 10);
    const type = match[2];
    const paramsText = match[3];

    // Parse attributes
    const attributes = parseAttributeList(paramsText);

    return { expressId, type, attributes };
  } catch (error) {
    console.warn(`Failed to parse entity #${entityRef.expressId}:`, error);
    return null;
  }
}

/**
 * Parse attribute list from STEP format
 */
function parseAttributeList(paramsText: string): any[] {
  if (!paramsText.trim()) return [];

  const attributes: any[] = [];
  let depth = 0;
  let current = '';
  let inString = false;

  for (let i = 0; i < paramsText.length; i++) {
    const char = paramsText[i];

    if (char === "'") {
      if (inString) {
        // Check for escaped quote ('') - STEP uses doubled quotes
        if (i + 1 < paramsText.length && paramsText[i + 1] === "'") {
          current += "''";
          i++;
          continue;
        }
        inString = false;
      } else {
        inString = true;
      }
      current += char;
    } else if (inString) {
      current += char;
    } else if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      attributes.push(parseAttributeValue(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    attributes.push(parseAttributeValue(current.trim()));
  }

  return attributes;
}

/**
 * Parse a single attribute value
 */
function parseAttributeValue(value: string): any {
  value = value.trim();

  if (!value || value === '$') {
    return null;
  }

  // TypedValue: IFCTYPENAME(value) - must check before list check
  // Pattern: identifier followed by parentheses (e.g., IFCNORMALISEDRATIOMEASURE(0.5))
  const typedValueMatch = value.match(/^([A-Z][A-Z0-9_]*)\((.+)\)$/i);
  if (typedValueMatch) {
    const typeName = typedValueMatch[1];
    const innerValue = typedValueMatch[2].trim();
    // Return as array [typeName, parsedValue] to match Rust structure
    return [typeName, parseAttributeValue(innerValue)];
  }

  // List/Array
  if (value.startsWith('(') && value.endsWith(')')) {
    const listContent = value.slice(1, -1).trim();
    if (!listContent) return [];

    const items: any[] = [];
    let depth = 0;
    let current = '';

    for (let i = 0; i < listContent.length; i++) {
      const char = listContent[i];

      if (char === '(') {
        depth++;
        current += char;
      } else if (char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        const itemValue = current.trim();
        if (itemValue) items.push(parseAttributeValue(itemValue));
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) items.push(parseAttributeValue(current.trim()));
    return items;
  }

  // Reference: #123
  if (value.startsWith('#')) {
    const id = parseInt(value.substring(1), 10);
    return isNaN(id) ? null : id;
  }

  // String: 'text'
  if (value.startsWith("'") && value.endsWith("'")) {
    const raw = value.slice(1, -1).replace(/''/g, "'");
    // Decode IFC STEP encoded characters (\X2\00FC\X0\ -> ü, etc.)
    return decodeIfcString(raw);
  }

  // Number
  const num = parseFloat(value);
  if (!isNaN(num)) return num;

  // Enumeration or other identifier
  return value;
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
