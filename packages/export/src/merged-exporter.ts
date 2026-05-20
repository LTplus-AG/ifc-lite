/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merged IFC STEP exporter
 *
 * Combines multiple IFC models into a single STEP file, similar to
 * IfcOpenShell's MergeProjects recipe. Handles ID remapping, spatial
 * structure unification, and infrastructure deduplication.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { generateHeader } from '@ifc-lite/parser';
import { decodeIfcString } from '@ifc-lite/encoding';
import { safeUtf8Decode } from '@ifc-lite/data';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';

/** Regex to match #ID references in STEP entity text. */
const STEP_REF_REGEX = /#(\d+)/g;

/** Entity types forming shared infrastructure (deduplicated across models). */
const SHARED_INFRASTRUCTURE_TYPES = new Set([
  'IFCUNITASSIGNMENT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
]);

/** Lookup tables for matching spatial entities from the first model. */
interface SpatialLookup {
  sitesByName: Map<string, number>;
  buildingsByName: Map<string, number>;
  storeysByName: Map<string, number>;
  storeysByElevation: Array<{ expressId: number; elevation: number }>;
  siteIds: number[];
  buildingIds: number[];
}

/**
 * A model to be included in the merge, with its data store and metadata.
 */
export interface MergeModelInput {
  /** Unique model identifier */
  id: string;
  /** Display name */
  name: string;
  /** Parsed IFC data store (must have source buffer) */
  dataStore: IfcDataStore;
}

/**
 * Options for merged STEP export
 */
export interface MergeExportOptions {
  /** IFC schema version for the output file (any version, will convert if needed) */
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  /** File description */
  description?: string;
  /** Author name */
  author?: string;
  /** Organization name */
  organization?: string;
  /** Application name (defaults to 'ifc-lite') */
  application?: string;
  /** Output filename */
  filename?: string;

  /**
   * Strategy for merging the project hierarchy.
   * - 'keep-first': Keep the first model's IfcProject as the root
   */
  projectStrategy?: 'keep-first';

  /** Apply visibility filtering to each model before merging */
  visibleOnly?: boolean;
  /** Hidden entity IDs per model (local expressIds) */
  hiddenEntityIdsByModel?: Map<string, Set<number>>;
  /** Isolated entity IDs per model (null = no isolation) */
  isolatedEntityIdsByModel?: Map<string, Set<number> | null>;

  /** Progress callback for async export */
  onProgress?: (progress: ExportProgress) => void;
}

/**
 * Progress information during export
 */
export interface ExportProgress {
  /** Current phase of export */
  phase: 'preparing' | 'entities' | 'assembling';
  /** Progress 0-1 */
  percent: number;
  /** Number of entities processed so far */
  entitiesProcessed: number;
  /** Total entities to process */
  entitiesTotal: number;
  /** Current model being processed (for merged export) */
  currentModel?: string;
}

/**
 * Result of merged STEP export
 */
export interface MergeExportResult {
  /** STEP file content as bytes (avoids V8 string length limit for large files) */
  content: Uint8Array;
  /** Statistics */
  stats: {
    /** Number of models merged */
    modelCount: number;
    /** Total entities in the output */
    totalEntityCount: number;
    /** File size in bytes */
    fileSize: number;
  };
}

/**
 * Merges multiple IFC models into a single STEP file.
 *
 * Uses the same approach as IfcOpenShell's MergeProjects recipe, extended
 * with spatial hierarchy unification:
 * 1. First model's entities use their original IDs
 * 2. Subsequent models' IDs are offset to avoid collisions
 * 3. IfcProject is unified — all references remapped to the first model's project
 * 4. Spatial structure (Site, Building, Storey) is unified by name/elevation:
 *    matching entities are remapped to the first model's equivalents so that
 *    products from all models end up in the same unified tree
 * 5. Duplicate entities and shared infrastructure (units, contexts) are skipped
 */
export class MergedExporter {
  private models: MergeModelInput[];

  constructor(models: MergeModelInput[]) {
    if (models.length === 0) {
      throw new Error('MergedExporter requires at least one model');
    }
    this.models = models;
  }

  export(options: MergeExportOptions): MergeExportResult {
    const onProgress = options.onProgress;
    const schema = (options.schema || 'IFC4') as IfcSchemaVersion;

    // Generate header
    const header = generateHeader({
      schema,
      description: options.description || `Merged export of ${this.models.length} models from ifc-lite`,
      author: options.author || '',
      organization: options.organization || '',
      application: options.application || 'ifc-lite',
      filename: options.filename || 'merged.ifc',
    });

    const allEntityLines: string[] = [];

    // Track ID offsets per model
    let nextAvailableId = 1;
    const modelOffsets = new Map<string, number>();

    // First pass: determine ID offsets
    for (const model of this.models) {
      modelOffsets.set(model.id, nextAvailableId - 1); // offset = nextAvailableId - 1 so IDs start at nextAvailableId
      let maxId = 0;
      for (const [id] of model.dataStore.entityIndex.byId) {
        if (id > maxId) maxId = id;
      }
      nextAvailableId += maxId;
    }

    // Collect first model's info for deduplication
    const firstModel = this.models[0];
    const firstModelOffset = modelOffsets.get(firstModel.id)!;
    const firstModelInfraMap = this.findInfrastructureEntities(firstModel.dataStore);
    const firstProjectIds = this.findEntitiesByType(firstModel.dataStore, 'IFCPROJECT');

    // Build spatial lookup from first model for Site/Building/Storey unification
    const spatialLookup = this.buildSpatialLookup(firstModel.dataStore);

    // Process each model
    let isFirstModel = true;

    for (const model of this.models) {
      const offset = modelOffsets.get(model.id)!;
      const source = model.dataStore.source;
      if (!source || source.length === 0) continue;

      // Determine which entities to include
      let includedEntityIds: Set<number> | null = null;

      if (options.visibleOnly) {
        const hiddenIds = options.hiddenEntityIdsByModel?.get(model.id) ?? new Set<number>();
        const isolatedIds = options.isolatedEntityIdsByModel?.get(model.id) ?? null;
        const { roots, hiddenProductIds } = getVisibleEntityIds(model.dataStore, hiddenIds, isolatedIds);
        includedEntityIds = collectReferencedEntityIds(
          roots,
          source,
          model.dataStore.entityIndex.byId,
          hiddenProductIds,
        );
        // Second pass: collect style entities that reference included geometry
        collectStyleEntities(includedEntityIds, source, model.dataStore.entityIndex);
      }

      // Build remap table (references to remap) and skip set (entities to omit)
      const sharedRemap = new Map<number, number>();
      const skipEntityIds = new Set<number>();

      if (!isFirstModel) {
        // Remap this model's IfcProject references → first model's IfcProject.
        const projectIds = this.findEntitiesByType(model.dataStore, 'IFCPROJECT');
        if (firstProjectIds.length > 0) {
          for (const pid of projectIds) {
            sharedRemap.set(pid, firstProjectIds[0] + firstModelOffset);
            skipEntityIds.add(pid);
          }
        }

        // Remap and skip duplicate infrastructure (units, contexts)
        const modelInfra = this.findInfrastructureEntities(model.dataStore);
        for (const [type, firstIds] of firstModelInfraMap) {
          const thisIds = modelInfra.get(type);
          if (thisIds && firstIds.length > 0 && thisIds.length > 0) {
            sharedRemap.set(thisIds[0], firstIds[0] + firstModelOffset);
            skipEntityIds.add(thisIds[0]);
          }
        }

        // Unify spatial hierarchy: match Site, Building, Storey to first model
        this.unifySpatialEntities(
          model.dataStore, spatialLookup, firstModelOffset,
          sharedRemap, skipEntityIds,
        );

        // Skip IfcRelAggregates that become fully redundant after unification.
        // e.g. Model2's Project→Site becomes FirstProject→FirstSite which
        // already exists from Model1, causing duplicate tree nodes.
        this.skipRedundantRelAggregates(
          model.dataStore, sharedRemap, skipEntityIds,
        );
      }

      // Emit entities for this model
      for (const [expressId, entityRef] of model.dataStore.entityIndex.byId) {
        // Skip entities outside the visible closure
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) {
          continue;
        }

        // Skip duplicate entities (project, infrastructure)
        if (skipEntityIds.has(expressId)) {
          continue;
        }

        // Get original entity text — safeUtf8Decode handles SAB-backed sources
        const entityText = safeUtf8Decode(
          source, entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength,
        );

        // Remap IDs if this is not the first model or if offset is non-zero
        let finalText: string;
        if (offset === 0 && sharedRemap.size === 0) {
          finalText = entityText;
        } else {
          finalText = this.remapEntityText(entityText, offset, sharedRemap);
        }

        // Apply schema conversion if target differs from source
        const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
        if (needsConversion(sourceSchema, schema)) {
          const converted = convertStepLine(finalText, sourceSchema, schema);
          if (converted !== null) {
            allEntityLines.push(converted);
          }
        } else {
          allEntityLines.push(finalText);
        }
      }

      isFirstModel = false;
    }

    // Assemble final file as Uint8Array chunks to avoid V8 string length limit
    if (onProgress) onProgress({ phase: 'assembling', percent: 0.9, entitiesProcessed: allEntityLines.length, entitiesTotal: allEntityLines.length });
    const content = assembleStepBytes(header, allEntityLines);

    return {
      content,
      stats: {
        modelCount: this.models.length,
        totalEntityCount: allEntityLines.length,
        fileSize: content.byteLength,
      },
    };
  }

  /**
   * Async export that yields to the event loop between entity chunks,
   * reporting progress via the onProgress callback. This keeps the UI
   * responsive during large merged exports.
   */
  async exportAsync(options: MergeExportOptions): Promise<MergeExportResult> {
    const onProgress = options.onProgress;

    const schema = (options.schema || 'IFC4') as IfcSchemaVersion;
    const header = generateHeader({
      schema,
      description: options.description || `Merged export of ${this.models.length} models from ifc-lite`,
      author: options.author || '',
      organization: options.organization || '',
      application: options.application || 'ifc-lite',
      filename: options.filename || 'merged.ifc',
    });

    const allEntityLines: string[] = [];

    // First pass: count total entities for progress
    let totalEntities = 0;
    for (const model of this.models) {
      totalEntities += model.dataStore.entityIndex.byId.size;
    }

    let nextAvailableId = 1;
    const modelOffsets = new Map<string, number>();

    for (const model of this.models) {
      modelOffsets.set(model.id, nextAvailableId - 1);
      let maxId = 0;
      for (const [id] of model.dataStore.entityIndex.byId) {
        if (id > maxId) maxId = id;
      }
      nextAvailableId += maxId;
    }

    const firstModel = this.models[0];
    const firstModelOffset = modelOffsets.get(firstModel.id)!;
    const firstModelInfraMap = this.findInfrastructureEntities(firstModel.dataStore);
    const firstProjectIds = this.findEntitiesByType(firstModel.dataStore, 'IFCPROJECT');
    const spatialLookup = this.buildSpatialLookup(firstModel.dataStore);

    let isFirstModel = true;
    let entitiesProcessed = 0;
    const YIELD_INTERVAL = 2000;

    if (onProgress) onProgress({ phase: 'preparing', percent: 0, entitiesProcessed: 0, entitiesTotal: totalEntities });

    for (const model of this.models) {
      const offset = modelOffsets.get(model.id)!;
      const source = model.dataStore.source;
      if (!source || source.length === 0) continue;

      if (onProgress) {
        onProgress({
          phase: 'entities',
          percent: totalEntities > 0 ? (entitiesProcessed / totalEntities) * 0.85 : 0,
          entitiesProcessed,
          entitiesTotal: totalEntities,
          currentModel: model.name,
        });
      }

      let includedEntityIds: Set<number> | null = null;
      if (options.visibleOnly) {
        const hiddenIds = options.hiddenEntityIdsByModel?.get(model.id) ?? new Set<number>();
        const isolatedIds = options.isolatedEntityIdsByModel?.get(model.id) ?? null;
        const { roots, hiddenProductIds } = getVisibleEntityIds(model.dataStore, hiddenIds, isolatedIds);
        includedEntityIds = collectReferencedEntityIds(
          roots, source, model.dataStore.entityIndex.byId, hiddenProductIds,
        );
        collectStyleEntities(includedEntityIds, source, model.dataStore.entityIndex);
      }

      const sharedRemap = new Map<number, number>();
      const skipEntityIds = new Set<number>();

      if (!isFirstModel) {
        const projectIds = this.findEntitiesByType(model.dataStore, 'IFCPROJECT');
        if (firstProjectIds.length > 0) {
          for (const pid of projectIds) {
            sharedRemap.set(pid, firstProjectIds[0] + firstModelOffset);
            skipEntityIds.add(pid);
          }
        }

        const modelInfra = this.findInfrastructureEntities(model.dataStore);
        for (const [type, firstIds] of firstModelInfraMap) {
          const thisIds = modelInfra.get(type);
          if (thisIds && firstIds.length > 0 && thisIds.length > 0) {
            sharedRemap.set(thisIds[0], firstIds[0] + firstModelOffset);
            skipEntityIds.add(thisIds[0]);
          }
        }

        this.unifySpatialEntities(model.dataStore, spatialLookup, firstModelOffset, sharedRemap, skipEntityIds);
        this.skipRedundantRelAggregates(model.dataStore, sharedRemap, skipEntityIds);
      }

      let entityCount = 0;
      for (const [expressId, entityRef] of model.dataStore.entityIndex.byId) {
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) continue;
        if (skipEntityIds.has(expressId)) continue;

        const entityText = safeUtf8Decode(
          source, entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength,
        );

        let finalText: string;
        if (offset === 0 && sharedRemap.size === 0) {
          finalText = entityText;
        } else {
          finalText = this.remapEntityText(entityText, offset, sharedRemap);
        }

        const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
        if (needsConversion(sourceSchema, schema)) {
          const converted = convertStepLine(finalText, sourceSchema, schema);
          if (converted !== null) allEntityLines.push(converted);
        } else {
          allEntityLines.push(finalText);
        }

        entityCount++;
        entitiesProcessed++;

        // Yield to event loop every YIELD_INTERVAL entities
        if (entityCount % YIELD_INTERVAL === 0) {
          if (onProgress) {
            onProgress({
              phase: 'entities',
              percent: totalEntities > 0 ? (entitiesProcessed / totalEntities) * 0.85 : 0,
              entitiesProcessed,
              entitiesTotal: totalEntities,
              currentModel: model.name,
            });
          }
          await new Promise(r => setTimeout(r, 0));
        }
      }

      isFirstModel = false;
    }

    // Assembly phase
    if (onProgress) {
      onProgress({ phase: 'assembling', percent: 0.9, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    }
    await new Promise(r => setTimeout(r, 0));

    const content = assembleStepBytes(header, allEntityLines);

    if (onProgress) {
      onProgress({ phase: 'assembling', percent: 1, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    }

    return {
      content,
      stats: {
        modelCount: this.models.length,
        totalEntityCount: allEntityLines.length,
        fileSize: content.byteLength,
      },
    };
  }

  /**
   * Remap all #ID references in a STEP entity line.
   * Applies offset to all IDs, then overrides with specific remappings.
   */
  private remapEntityText(
    entityText: string,
    offset: number,
    sharedRemap: Map<number, number>,
  ): string {
    return entityText.replace(STEP_REF_REGEX, (_match, idStr: string) => {
      const originalId = parseInt(idStr, 10);

      // Check if this ID has a specific remap (project, shared infrastructure)
      const remapped = sharedRemap.get(originalId);
      if (remapped !== undefined) {
        return `#${remapped}`;
      }

      // Apply offset
      return `#${originalId + offset}`;
    });
  }

  /**
   * Find entity IDs of shared infrastructure types in a data store.
   * Returns a map of uppercase type name → array of expressIds.
   */
  private findInfrastructureEntities(
    dataStore: IfcDataStore,
  ): Map<string, number[]> {
    const result = new Map<string, number[]>();

    for (const type of SHARED_INFRASTRUCTURE_TYPES) {
      const ids = dataStore.entityIndex.byType.get(type) ?? [];
      if (ids.length > 0) {
        result.set(type, [...ids]);
      }
    }

    return result;
  }

  /**
   * Find entity IDs of a specific type in a data store.
   */
  private findEntitiesByType(dataStore: IfcDataStore, typeUpper: string): number[] {
    return dataStore.entityIndex.byType.get(typeUpper) ?? [];
  }

  /**
   * Build lookup tables from the first model's spatial entities for
   * matching against subsequent models during merge.
   */
  private buildSpatialLookup(dataStore: IfcDataStore): SpatialLookup {
    const lookup: SpatialLookup = {
      sitesByName: new Map(),
      buildingsByName: new Map(),
      storeysByName: new Map(),
      storeysByElevation: [],
      siteIds: [],
      buildingIds: [],
    };

    for (const id of this.findEntitiesByType(dataStore, 'IFCSITE')) {
      lookup.siteIds.push(id);
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.sitesByName.set(name.toLowerCase(), id);
    }

    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDING')) {
      lookup.buildingIds.push(id);
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.buildingsByName.set(name.toLowerCase(), id);
    }

    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDINGSTOREY')) {
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.storeysByName.set(name.toLowerCase(), id);
      const elevation = this.extractStoreyElevation(id, dataStore);
      if (elevation !== undefined) {
        lookup.storeysByElevation.push({ expressId: id, elevation });
      }
    }

    return lookup;
  }

  /**
   * Match a subsequent model's spatial entities (Site, Building, Storey)
   * to the first model's equivalents. Matched entities are remapped and
   * their duplicate entity is skipped from output.
   *
   * Matching strategy:
   * - Sites/Buildings: by name (case-insensitive), or if only one in each model
   * - Storeys: by name first, then by elevation (tolerance ±0.5 model units)
   */
  private unifySpatialEntities(
    dataStore: IfcDataStore,
    lookup: SpatialLookup,
    firstModelOffset: number,
    sharedRemap: Map<number, number>,
    skipEntityIds: Set<number>,
  ): void {
    // Unify IfcSite
    const sites = this.findEntitiesByType(dataStore, 'IFCSITE');
    for (const id of sites) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;
      if (name) match = lookup.sitesByName.get(name.toLowerCase());
      // If single site in both models, unify regardless of name
      if (match === undefined && sites.length === 1 && lookup.siteIds.length === 1) {
        match = lookup.siteIds[0];
      }
      if (match !== undefined) {
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuilding
    const buildings = this.findEntitiesByType(dataStore, 'IFCBUILDING');
    for (const id of buildings) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;
      if (name) match = lookup.buildingsByName.get(name.toLowerCase());
      if (match === undefined && buildings.length === 1 && lookup.buildingIds.length === 1) {
        match = lookup.buildingIds[0];
      }
      if (match !== undefined) {
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuildingStorey — name match first, then elevation fallback
    const matchedFirstStoreys = new Set<number>();
    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDINGSTOREY')) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;

      // Try name match
      if (name) {
        const candidate = lookup.storeysByName.get(name.toLowerCase());
        if (candidate !== undefined && !matchedFirstStoreys.has(candidate)) {
          match = candidate;
        }
      }

      // Fallback: match by elevation
      if (match === undefined) {
        const elevation = this.extractStoreyElevation(id, dataStore);
        if (elevation !== undefined) {
          for (const entry of lookup.storeysByElevation) {
            if (matchedFirstStoreys.has(entry.expressId)) continue;
            const tolerance = Math.max(0.5, Math.abs(entry.elevation) * 0.01);
            if (Math.abs(elevation - entry.elevation) <= tolerance) {
              match = entry.expressId;
              break;
            }
          }
        }
      }

      if (match !== undefined) {
        matchedFirstStoreys.add(match);
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }
  }

  /**
   * Skip IfcRelAggregates that become fully redundant after spatial unification.
   *
   * When Model2's `IfcRelAggregates(Project, (Site))` gets remapped to
   * `IfcRelAggregates(FirstProject, (FirstSite))`, it duplicates Model1's
   * existing relationship, causing viewers to show Site multiple times.
   *
   * An IfcRelAggregates is redundant if both its RelatingObject (attr 4)
   * and ALL its RelatedObjects (attr 5) were remapped via sharedRemap.
   */
  private skipRedundantRelAggregates(
    dataStore: IfcDataStore,
    sharedRemap: Map<number, number>,
    skipEntityIds: Set<number>,
  ): void {
    for (const relId of this.findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
      // RelatingObject is attr 4 — single #ref
      const relatingAttr = this.extractStepAttribute(relId, dataStore, 4);
      if (!relatingAttr) continue;
      const relatingRef = relatingAttr.match(/^#(\d+)$/);
      if (!relatingRef || !sharedRemap.has(parseInt(relatingRef[1], 10))) continue;

      // RelatedObjects is attr 5 — list of #refs like (#2,#3)
      const relatedAttr = this.extractStepAttribute(relId, dataStore, 5);
      if (!relatedAttr) continue;
      const refs: number[] = [];
      const refRegex = /#(\d+)/g;
      let m;
      while ((m = refRegex.exec(relatedAttr)) !== null) {
        refs.push(parseInt(m[1], 10));
      }
      if (refs.length === 0) continue;

      // If ALL related objects were also remapped, this rel is fully redundant
      if (refs.every(ref => sharedRemap.has(ref))) {
        skipEntityIds.add(relId);
      }
    }
  }

  /**
   * Extract the Name attribute (index 2) from a STEP entity.
   */
  private extractEntityName(
    expressId: number,
    dataStore: IfcDataStore,
  ): string | null {
    const attr = this.extractStepAttribute(expressId, dataStore, 2);
    if (!attr || attr === '$') return null;
    if (attr.startsWith("'") && attr.endsWith("'")) {
      const raw = attr.slice(1, -1).replace(/''/g, "'");
      return decodeIfcString(raw);
    }
    return null;
  }

  /**
   * Extract the Elevation attribute (index 9) from an IfcBuildingStorey.
   */
  private extractStoreyElevation(
    expressId: number,
    dataStore: IfcDataStore,
  ): number | undefined {
    const attr = this.extractStepAttribute(expressId, dataStore, 9);
    if (!attr || attr === '$') return undefined;
    // Handle typed value like IFCLENGTHMEASURE(3000.)
    const typedMatch = attr.match(/^[A-Z_]+\(([^)]+)\)$/i);
    const numStr = typedMatch ? typedMatch[1] : attr;
    const num = parseFloat(numStr);
    return isNaN(num) ? undefined : num;
  }

  /**
   * Extract a specific attribute (by 0-based index) from a STEP entity's
   * raw text. Returns the raw string value (e.g., "'Name'", "$", "#123").
   */
  private extractStepAttribute(
    expressId: number,
    dataStore: IfcDataStore,
    attrIndex: number,
  ): string | null {
    const source = dataStore.source;
    if (!source) return null;
    const ref = dataStore.entityIndex.byId.get(expressId);
    if (!ref) return null;

    const entityText = safeUtf8Decode(
      source, ref.byteOffset, ref.byteOffset + ref.byteLength,
    );

    // Find opening paren after type name
    const openParen = entityText.indexOf('(');
    if (openParen === -1) return null;

    let depth = 0;
    let attrCount = 0;
    let attrStart = openParen + 1;
    let inString = false;

    for (let i = openParen + 1; i < entityText.length; i++) {
      const ch = entityText[i];

      if (ch === "'" && !inString) {
        inString = true;
      } else if (ch === "'" && inString) {
        // Check for escaped quote ''
        if (i + 1 < entityText.length && entityText[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
      } else if (!inString) {
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          if (depth === 0) {
            return attrCount === attrIndex
              ? entityText.substring(attrStart, i).trim()
              : null;
          }
          depth--;
        } else if (ch === ',' && depth === 0) {
          if (attrCount === attrIndex) {
            return entityText.substring(attrStart, i).trim();
          }
          attrCount++;
          attrStart = i + 1;
        }
      }
    }

    return null;
  }

}

/**
 * Assemble a STEP file from header and entity lines as a Uint8Array.
 * Encodes each entity individually to avoid hitting V8's ~256 MB string length limit
 * when merging large models.
 */
function assembleStepBytes(header: string, entities: string[]): Uint8Array {
  const encoder = new TextEncoder();

  const headBytes = encoder.encode(`${header}DATA;\n`);
  const tailBytes = encoder.encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const newline = encoder.encode('\n');

  // Calculate total size
  let totalSize = headBytes.byteLength + tailBytes.byteLength;
  const entityBytes: Uint8Array[] = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) {
    entityBytes[i] = encoder.encode(entities[i]);
    totalSize += entityBytes[i].byteLength + newline.byteLength;
  }

  // Assemble into a single buffer
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(headBytes, offset);
  offset += headBytes.byteLength;

  for (let i = 0; i < entityBytes.length; i++) {
    result.set(entityBytes[i], offset);
    offset += entityBytes[i].byteLength;
    result.set(newline, offset);
    offset += newline.byteLength;
  }

  result.set(tailBytes, offset);

  return result;
}
