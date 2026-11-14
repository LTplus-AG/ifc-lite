/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcParser` in its own module, re-exported unchanged from the package index.
 *
 * The parser worker imports it from here rather than from `./index.js`: the
 * index also reaches `.ifczip` unwrapping (jszip) and the cost evaluator
 * (decimal.js), and every byte the worker bundle carries is fetched,
 * compiled and evaluated before the worker can accept a parse.
 */

import { createLogger } from '@ifc-lite/data';
import type { IfcEntity, ParseResult } from './types.js';
import { EntityIndexBuilder } from './entity-index.js';
import { EntityExtractor } from './entity-extractor.js';
import { PropertyExtractor } from './property-extractor.js';
import { RelationshipExtractor } from './relationship-extractor.js';
import { parseColumnarInput, type IfcDataStore } from './columnar-parser.js';
import { scanIfcEntities, scanColumnarEntities, type PreScannedEntityIndex, type WasmScanApi } from './entity-scanner.js';

export interface ParseOptions {
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onDiagnostic?: (message: string) => void;
  onScanReport?: (report: import('./scan-report.js').EntityScanReport) => void;
  wasmApi?: WasmScanApi; // Optional IfcAPI instance for WASM-accelerated entity scanning
  /** Yield budget for large incremental parses. Higher values finish faster with longer main-thread slices. */
  yieldIntervalMs?: number;
  /** Keep property-set containers in the primary index but defer indexing individual property/quantity atoms. */
  deferPropertyAtomIndex?: boolean;
  /** Skip worker-based entity scanning and stay in-process. Useful for huge buffers already loaded on the main thread. */
  disableWorkerScan?: boolean;
  /** Called when spatial hierarchy is ready, BEFORE property/association parsing completes.
   *  Use this to show the hierarchy panel early while the full parse finishes. */
  onSpatialReady?: (partialStore: IfcDataStore) => void;
  /**
   * Pre-built entity index from another worker (typically the streaming
   * geometry pre-pass). When supplied, `parseColumnar` skips both the
   * worker-based and WASM scans and retains the numeric columns through
   * entity categorization. Only records needed for metadata extraction
   * materialize EntityRefs; every record remains addressable in the store.
   */
  preScannedEntityIndex?: PreScannedEntityIndex;
}

const parserLog = createLogger('IfcParser');

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
    const { entityRefs, entityColumns, processed, elapsedMs, scanPath } = await scanColumnarEntities(buffer, options);
    parserLog.debug(`Fast scan: ${processed} entities in ${elapsedMs.toFixed(0)}ms (path=${scanPath})`);

    // Build columnar structures with on-demand property extraction
    const dataStore = await parseColumnarInput(buffer, entityColumns ?? entityRefs, options);
    return dataStore;
  }
}
