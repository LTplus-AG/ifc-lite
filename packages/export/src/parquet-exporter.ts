/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parquet exporter for ara3d BOS-compatible format
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcTypeEnum, EntityFlags, PropertyValueType, QuantityType, RelationshipType, IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import { columnsToParquet } from './columns-to-parquet.js';

export interface ParquetExportOptions {
    includeGeometry?: boolean;
}

/**
 * Export to ara3d BIM Open Schema compatible Parquet files.
 * Creates a .bos archive (ZIP of Parquet files).
 */
export class ParquetExporter {
    private store: IfcDataStore;
    private geometryResult?: GeometryResult;
    private mutationView: MutablePropertyView | null;

    /**
     * `mutationView` is OPTIONAL: existing `new ParquetExporter(store)` callers
     * (README example, `tests/integration.test.ts`) keep working unchanged and
     * keep exporting the source model as parsed.
     *
     * When supplied, entities the overlay tombstoned via
     * `MutablePropertyView.deleteEntity()` — and every row that references
     * one — are dropped from `Entities`, `Properties`, `Quantities`,
     * `Relationships`, `SpatialHierarchy` and the geometry tables
     * (`VertexBuffer`, `IndexBuffer`, `Meshes`) (#2046; geometry tables
     * joined the set after they were found still emitting a deleted
     * entity's mesh into an otherwise-filtered archive). Unlike
     * `StepExporter`/`Ifc5Exporter`, this is deletion-only: unlike those
     * two, the writers below column-copy typed arrays out of the store in
     * one shot rather than looping per entity, so they cannot also apply
     * the overlay's pset/quantity/attribute edits the way a per-entity
     * emission pass can. That is a known, separate gap.
     */
    constructor(store: IfcDataStore, geometryResult?: GeometryResult, mutationView?: MutablePropertyView) {
        this.store = store;
        this.geometryResult = geometryResult;
        this.mutationView = mutationView ?? null;
    }

    /**
     * The one authority for "does this entity still exist", overlay first —
     * mirrors `StepExporter`/`Ifc5Exporter` (see `effective-index.ts`).
     * `null` when no overlay was supplied, so every writer below takes the
     * unfiltered fast path.
     */
    private getEffective(): EffectiveEntityIndex | null {
        if (!this.mutationView) return null;
        // Derived per call, never memoised. The overlay is a LIVE view the
        // caller still holds: caching it here made a second export replay the
        // first one's deletion set. `ParquetExporter` has no in-repo callers,
        // so external usage IS the contract and "construct once, export, edit,
        // export again" is ordinary — there is no call site we control that
        // would make staleness unreachable. (#2111 review)
        return getEffectiveEntityIndex(this.store, this.mutationView, true);
    }

    /**
     * Export full model to .bos archive.
     */
    async exportBOS(options: ParquetExportOptions = {}): Promise<Uint8Array> {
        const files = new Map<string, Uint8Array>();

        // Non-geometry files
        files.set('Entities.parquet', await this.writeEntities());
        files.set('Properties.parquet', await this.writeProperties());
        files.set('Quantities.parquet', await this.writeQuantities());
        files.set('Relationships.parquet', await this.writeRelationships());
        files.set('Strings.parquet', await this.writeStrings());

        // Geometry files (if available)
        if (options.includeGeometry !== false && this.geometryResult) {
            files.set('VertexBuffer.parquet', await this.writeVertexBuffer());
            files.set('IndexBuffer.parquet', await this.writeIndexBuffer());
            files.set('Meshes.parquet', await this.writeMeshes());
        }

        // Spatial hierarchy
        if (this.store.spatialHierarchy) {
            files.set('SpatialHierarchy.parquet', await this.writeSpatialHierarchy());
        }

        // Metadata
        files.set('Metadata.json', this.writeMetadata());

        return this.createZipArchive(files);
    }

    /**
     * Export individual Parquet file.
     */
    async exportTable(tableName: string): Promise<Uint8Array> {
        switch (tableName) {
            case 'entities': return this.writeEntities();
            case 'properties': return this.writeProperties();
            case 'quantities': return this.writeQuantities();
            case 'relationships': return this.writeRelationships();
            case 'strings': return this.writeStrings();
            case 'vertices': return this.writeVertexBuffer();
            case 'indices': return this.writeIndexBuffer();
            case 'meshes': return this.writeMeshes();
            default: throw new Error(`Unknown table: ${tableName}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ENTITY DATA
    // ═══════════════════════════════════════════════════════════════

    private async writeEntities(): Promise<Uint8Array> {
        const { entities, strings } = this.store;
        const effective = this.getEffective();

        const expressId = Array.from(entities.expressId);
        // Row i's identity IS expressId[i] (columnar layout, one row per
        // parsed entity) — the same predicate every other column below is
        // filtered by.
        const keep = effective ? expressId.map((id) => !effective.isDeleted(id)) : null;

        return this.toParquet(filterColumns({
            ExpressId: expressId,
            GlobalId: mapTypedArray(entities.globalId, i => strings.get(i)),
            Name: mapTypedArray(entities.name, i => strings.get(i)),
            Description: mapTypedArray(entities.description, i => strings.get(i)),
            // Overlay-aware: a `setEntityType` retype changes what
            // StepExporter/Ifc5Exporter write for this entity's class
            // (step-exporter.ts effectiveType = typeMut?.newType ?? entity.type);
            // this column now asks the same `effective` index instead of reading
            // the pre-retype `entities.typeEnum` unconditionally, so a
            // retyped-then-exported row no longer disagrees with those two
            // exporters.
            //
            // The unretyped name comes from `entities.getTypeName(id)`, the
            // store's own canonical answer, NOT from re-deriving PascalCase out
            // of `typeEnum` through IFC_ENTITY_NAMES. That round trip is lossy
            // by construction and had already gone stale once (the table was
            // missing 4 of the 125 enum types until #2319); `getTypeName` also
            // falls back to the raw parsed type name when an entity's type is
            // outside the generated enum, where `IfcTypeEnumToString` yields the
            // literal string 'Unknown'.
            //
            // `typeOf` answers for EVERY indexed entity, not only retyped ones,
            // so it cannot be the source for untouched rows. Override only when
            // the overlay actually DISAGREES with the parsed class.
            Type: expressId.map((id) => {
                const source = entities.getTypeName(id);
                const effectiveType = effective?.typeOf(id);
                if (effectiveType === undefined || effectiveType === source.toUpperCase()) {
                    return source;
                }
                return IFC_ENTITY_NAMES[effectiveType] ?? effectiveType;
            }),
            ObjectType: mapTypedArray(entities.objectType, i => strings.get(i)),
            HasGeometry: mapTypedArray(entities.flags, f => (f & EntityFlags.HAS_GEOMETRY) !== 0),
            IsType: mapTypedArray(entities.flags, f => (f & EntityFlags.IS_TYPE) !== 0),
            ContainedInStorey: Array.from(entities.containedInStorey),
            DefinedByType: Array.from(entities.definedByType),
            GeometryIndex: Array.from(entities.geometryIndex),
        }, keep));
    }

    private async writeProperties(): Promise<Uint8Array> {
        const { properties, strings } = this.store;
        const effective = this.getEffective();

        const entityId = Array.from(properties.entityId);
        // A property row belongs to the entity named in its own EntityId
        // column, not to its own row index — filter on that, not on ExpressId.
        const keep = effective ? entityId.map((id) => !effective.isDeleted(id)) : null;

        return this.toParquet(filterColumns({
            EntityId: entityId,
            PsetName: mapTypedArray(properties.psetName, i => strings.get(i)),
            PsetGlobalId: mapTypedArray(properties.psetGlobalId, i => strings.get(i)),
            PropName: mapTypedArray(properties.propName, i => strings.get(i)),
            PropType: mapTypedArray(properties.propType, t => PropertyValueTypeToString(t)),
            ValueString: mapTypedArray(properties.valueString, i => i >= 0 && i < strings.count ? strings.get(i) : null),
            ValueReal: Array.from(properties.valueReal),
            ValueInt: Array.from(properties.valueInt),
            ValueBool: mapTypedArray(properties.valueBool, v => v === 255 ? null : v === 1),
        }, keep), new Set(['ValueReal']));
    }

    private async writeQuantities(): Promise<Uint8Array> {
        const { quantities, strings } = this.store;
        const effective = this.getEffective();

        const entityId = Array.from(quantities.entityId);
        const keep = effective ? entityId.map((id) => !effective.isDeleted(id)) : null;

        return this.toParquet(filterColumns({
            EntityId: entityId,
            QsetName: mapTypedArray(quantities.qsetName, i => strings.get(i)),
            QuantityName: mapTypedArray(quantities.quantityName, i => strings.get(i)),
            QuantityType: mapTypedArray(quantities.quantityType, t => QuantityTypeToString(t)),
            Value: Array.from(quantities.value),
            Formula: mapTypedArray(quantities.formula, i => i > 0 ? strings.get(i) : null),
        }, keep), new Set(['Value']));
    }

    private async writeRelationships(): Promise<Uint8Array> {
        const { relationships } = this.store;
        const edges = relationships.forward;
        const effective = this.getEffective();

        // Flatten CSR format to row-based
        const sourceIds: number[] = [];
        const targetIds: number[] = [];
        const relTypes: string[] = [];
        const relIds: number[] = [];

        for (const [sourceId, offset] of edges.offsets) {
            const count = edges.counts.get(sourceId)!;
            for (let i = offset; i < offset + count; i++) {
                const targetId = edges.edgeTargets[i];
                // An edge naming a tombstoned entity on either end no longer
                // has a live entity to relate — drop the row rather than
                // leave a dangling SourceId/TargetId in the export.
                if (effective && (effective.isDeleted(sourceId) || effective.isDeleted(targetId))) continue;
                sourceIds.push(sourceId);
                targetIds.push(targetId);
                relTypes.push(RelationshipTypeToString(edges.edgeTypes[i]));
                relIds.push(edges.edgeRelIds[i]);
            }
        }

        return this.toParquet({
            SourceId: sourceIds,
            TargetId: targetIds,
            RelType: relTypes,
            RelId: relIds,
        });
    }

    private async writeStrings(): Promise<Uint8Array> {
        const { strings } = this.store;

        const indices = new Array(strings.count);
        for (let i = 0; i < strings.count; i++) {
            indices[i] = i;
        }

        return this.toParquet({
            Index: indices,
            Value: strings.getAll(),
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // GEOMETRY DATA (ara3d G3D compatible)
    // ═══════════════════════════════════════════════════════════════

    private async writeVertexBuffer(): Promise<Uint8Array> {
        if (!this.geometryResult) {
            throw new Error('Geometry result not available');
        }

        const effective = this.getEffective();

        // Collect all positions and normals from meshes
        const allPositions: number[] = [];
        const allNormals: number[] = [];

        for (const mesh of this.geometryResult.meshes) {
            // Same predicate as writeEntities/writeMeshes: a tombstoned
            // entity's geometry is not a row in Entities.parquet either, so
            // leaving its vertices here would let VertexBuffer.parquet name
            // (via Meshes.VertexStart/VertexCount) an entity no other table
            // has.
            if (effective?.isDeleted(mesh.expressId)) continue;
            // Positions are in the element's local frame (world = origin + position).
            // The BOS columnar layout has no transform column, so bake the per-mesh
            // origin into the world vertices. Normals are origin-invariant. No-op
            // when origin is absent/[0,0,0].
            const o = mesh.origin;
            if (o && (o[0] !== 0 || o[1] !== 0 || o[2] !== 0)) {
                const p = mesh.positions;
                for (let i = 0; i < p.length; i += 3) {
                    allPositions.push(p[i] + o[0], p[i + 1] + o[1], p[i + 2] + o[2]);
                }
            } else {
                allPositions.push(...Array.from(mesh.positions));
            }
            allNormals.push(...Array.from(mesh.normals));
        }

        const vertexCount = allPositions.length / 3;

        // Columnar layout (X[], Y[], Z[] instead of [x,y,z, x,y,z])
        const x = new Float32Array(vertexCount);
        const y = new Float32Array(vertexCount);
        const z = new Float32Array(vertexCount);
        const nx = new Float32Array(vertexCount);
        const ny = new Float32Array(vertexCount);
        const nz = new Float32Array(vertexCount);

        for (let i = 0; i < vertexCount; i++) {
            x[i] = allPositions[i * 3];
            y[i] = allPositions[i * 3 + 1];
            z[i] = allPositions[i * 3 + 2];
            nx[i] = allNormals[i * 3];
            ny[i] = allNormals[i * 3 + 1];
            nz[i] = allNormals[i * 3 + 2];
        }

        return this.toParquet({
            X: Array.from(x),
            Y: Array.from(y),
            Z: Array.from(z),
            NormalX: Array.from(nx),
            NormalY: Array.from(ny),
            NormalZ: Array.from(nz),
        });
    }

    private async writeIndexBuffer(): Promise<Uint8Array> {
        if (!this.geometryResult) {
            throw new Error('Geometry result not available');
        }

        const effective = this.getEffective();

        // Collect all indices from meshes
        const allIndices: number[] = [];
        for (const mesh of this.geometryResult.meshes) {
            if (effective?.isDeleted(mesh.expressId)) continue;
            allIndices.push(...Array.from(mesh.indices));
        }

        const triangleCount = allIndices.length / 3;

        const i0 = new Uint32Array(triangleCount);
        const i1 = new Uint32Array(triangleCount);
        const i2 = new Uint32Array(triangleCount);

        for (let i = 0; i < triangleCount; i++) {
            i0[i] = allIndices[i * 3];
            i1[i] = allIndices[i * 3 + 1];
            i2[i] = allIndices[i * 3 + 2];
        }

        return this.toParquet({ Index0: Array.from(i0), Index1: Array.from(i1), Index2: Array.from(i2) });
    }

    private async writeMeshes(): Promise<Uint8Array> {
        if (!this.geometryResult) {
            throw new Error('Geometry result not available');
        }

        const meshes = this.geometryResult.meshes;
        const effective = this.getEffective();
        const expressIds: number[] = [];
        const vertexStarts: number[] = [];
        const vertexCounts: number[] = [];
        const indexStarts: number[] = [];
        const indexCounts: number[] = [];

        let vertexOffset = 0;
        let indexOffset = 0;

        for (const mesh of meshes) {
            // Must match writeVertexBuffer/writeIndexBuffer's skip exactly —
            // those two accumulate the offsets this loop reports, so a mesh
            // dropped there but kept here (or vice versa) would misalign
            // every subsequent VertexStart/IndexStart.
            if (effective?.isDeleted(mesh.expressId)) continue;
            expressIds.push(mesh.expressId);
            vertexStarts.push(vertexOffset);
            vertexCounts.push(mesh.positions.length / 3);
            indexStarts.push(indexOffset);
            indexCounts.push(mesh.indices.length);

            vertexOffset += mesh.positions.length / 3;
            indexOffset += mesh.indices.length;
        }

        return this.toParquet({
            ExpressId: expressIds,
            VertexStart: vertexStarts,
            VertexCount: vertexCounts,
            IndexStart: indexStarts,
            IndexCount: indexCounts,
        });
    }

    private async writeSpatialHierarchy(): Promise<Uint8Array> {
        if (!this.store.spatialHierarchy) {
            throw new Error('Spatial hierarchy not available');
        }

        const rows: Array<{
            ElementId: number;
            StoreyId: number;
            BuildingId: number;
            SiteId: number;
            SpaceId: number;
        }> = [];

        const { spatialHierarchy } = this.store;
        const effective = this.getEffective();

        // Build lookup maps for fast parent access
        const storeyToBuilding = new Map<number, number>();
        const buildingToSite = new Map<number, number>();

        // Traverse hierarchy to build parent maps
        const traverse = (node: typeof spatialHierarchy.project, parentBuilding?: number, parentSite?: number): void => {
            if (node.type === IfcTypeEnum.IfcBuilding) {
                parentBuilding = node.expressId;
                if (parentSite !== undefined) {
                    buildingToSite.set(node.expressId, parentSite);
                }
            } else if (node.type === IfcTypeEnum.IfcSite) {
                parentSite = node.expressId;
            } else if (node.type === IfcTypeEnum.IfcBuildingStorey) {
                if (parentBuilding !== undefined) {
                    storeyToBuilding.set(node.expressId, parentBuilding);
                }
            }

            for (const child of node.children) {
                traverse(child, parentBuilding, parentSite);
            }
        };

        traverse(spatialHierarchy.project);

        for (const [storeyId, elementIds] of spatialHierarchy.byStorey) {
            const buildingId = storeyToBuilding.get(storeyId) ?? -1;
            const siteId = buildingId >= 0 ? (buildingToSite.get(buildingId) ?? -1) : -1;

            for (const elementId of elementIds) {
                // A tombstoned element is not a row in Entities.parquet either
                // (see writeEntities) — leaving it here would point
                // SpatialHierarchy.parquet at an id no other table has.
                //
                // Deletion-only, and only for the element itself: a deleted
                // STOREY/BUILDING/SITE still surfaces as StoreyId/BuildingId/
                // SiteId on a surviving element's row (spatialHierarchy is a
                // source-parse snapshot with no overlay-aware re-parenting —
                // the same class of problem Ifc5Exporter's re-parenting pass
                // solves, #2047 — not addressed here).
                if (effective?.isDeleted(elementId)) continue;

                // Check if element is in a space by iterating bySpace
                let spaceId = -1;
                for (const [sid, spaceElementIds] of spatialHierarchy.bySpace) {
                    if (spaceElementIds.includes(elementId)) {
                        spaceId = sid;
                        break;
                    }
                }

                rows.push({
                    ElementId: elementId,
                    StoreyId: storeyId,
                    BuildingId: buildingId,
                    SiteId: siteId,
                    SpaceId: spaceId,
                });
            }
        }

        return this.toParquet({
            ElementId: rows.map(r => r.ElementId),
            StoreyId: rows.map(r => r.StoreyId),
            BuildingId: rows.map(r => r.BuildingId),
            SiteId: rows.map(r => r.SiteId),
            SpaceId: rows.map(r => r.SpaceId),
        });
    }

    private writeMetadata(): Uint8Array {
        const metadata = {
            version: '2.0.0',
            generator: 'IFC-Lite',
            sourceFile: {
                size: this.store.fileSize,
                schema: this.store.schemaVersion,
                entityCount: this.store.entityCount,
            },
            export: {
                timestamp: new Date().toISOString(),
                format: 'ara3d-bos-compatible',
            },
            statistics: {
                meshCount: this.geometryResult?.meshes.length ?? 0,
                vertexCount: this.geometryResult ? this.geometryResult.totalVertices : 0,
                triangleCount: this.geometryResult ? this.geometryResult.totalTriangles : 0,
                propertyCount: this.store.properties.count,
                relationshipCount: this.store.relationships.forward.edgeTargets.length,
            },
        };

        return new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════

    /**
     * Column names whose domain is an unsigned 32-bit integer.
     *
     * Every one carries an IFC EXPRESS ID or an index into a geometry buffer,
     * and both are `u32` everywhere else in this codebase - `Uint32Array` in
     * the parser's entity index and its transports, `u32` in the Rust crates.
     * Arrow's content inference reaches for Int32 on any whole number, so an
     * express id at or above 2_147_483_648 came out NEGATIVE: an id-shaped
     * number that joins to nothing. STEP puts no upper bound on an entity id
     * below the `u32` the readers use, so that is reachable input rather than a
     * hypothetical.
     */
    private static readonly UINT32_COLUMNS: ReadonlySet<string> = new Set([
        'ExpressId', 'EntityId', 'SourceId', 'TargetId', 'RelId',
        'ElementId', 'StoreyId',
        'Index0', 'Index1', 'Index2',
        'VertexStart', 'VertexCount', 'IndexStart', 'IndexCount',
    ]);

    /**
     * NOT in the set above, deliberately: `BuildingId`, `SiteId` and `SpaceId`
     * in `SpatialHierarchy.parquet` carry **-1 as "none"** (see
     * `writeSpatialHierarchy` - a storey directly under the project has no
     * building). Declaring those unsigned turned that sentinel into
     * 4294967295: an id-shaped number where an obviously-absent marker used to
     * be, which is the exact failure this class of change exists to prevent.
     *
     * The residual gap is the narrower one: a building or site id at or above
     * 2^31 still wraps negative in those three columns. Fixing that properly
     * means writing NULL rather than -1 for "none", which changes what every
     * consumer reads for an absent parent and is a separate decision from the
     * id width.
     */

    private async toParquet(columns: Record<string, any[]>, floatColumns?: Set<string>): Promise<Uint8Array> {
        return columnsToParquet(columns, floatColumns, ParquetExporter.UINT32_COLUMNS);
    }

    private async createZipArchive(files: Map<string, Uint8Array>): Promise<Uint8Array> {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        for (const [name, data] of files) {
            zip.file(name, data);
        }

        return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    }
}

// Helper functions
function mapTypedArray<T extends TypedArray, R>(arr: T, fn: (v: number) => R): R[] {
    const result: R[] = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        result[i] = fn(arr[i]);
    }
    return result;
}

type TypedArray = Float32Array | Float64Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;

/**
 * Drop row `i` from every column when `keep[i]` is false. `keep === null`
 * (no overlay supplied) is the identity — returns `columns` unchanged so the
 * no-overlay export path allocates nothing extra.
 */
function filterColumns<T extends Record<string, unknown[]>>(columns: T, keep: boolean[] | null): T {
    if (!keep) return columns;
    const out = {} as T;
    for (const key of Object.keys(columns) as Array<keyof T>) {
        out[key] = (columns[key] as unknown[]).filter((_, i) => keep[i]) as T[keyof T];
    }
    return out;
}

function PropertyValueTypeToString(type: PropertyValueType): string {
    const names: Record<PropertyValueType, string> = {
        [PropertyValueType.String]: 'String',
        [PropertyValueType.Real]: 'Real',
        [PropertyValueType.Integer]: 'Integer',
        [PropertyValueType.Boolean]: 'Boolean',
        [PropertyValueType.Logical]: 'Logical',
        [PropertyValueType.Label]: 'Label',
        [PropertyValueType.Identifier]: 'Identifier',
        [PropertyValueType.Text]: 'Text',
        [PropertyValueType.Enum]: 'Enum',
        [PropertyValueType.Reference]: 'Reference',
        [PropertyValueType.List]: 'List',
    };
    return names[type] || 'Unknown';
}

// Quantity type conversion - exported for future use when quantities are implemented
export function QuantityTypeToString(type: QuantityType): string {
    const names: Record<QuantityType, string> = {
        [QuantityType.Length]: 'Length',
        [QuantityType.Area]: 'Area',
        [QuantityType.Volume]: 'Volume',
        [QuantityType.Count]: 'Count',
        [QuantityType.Weight]: 'Weight',
        [QuantityType.Time]: 'Time',
    };
    return names[type] || 'Unknown';
}

function RelationshipTypeToString(type: RelationshipType): string {
    const names: Record<RelationshipType, string> = {
        [RelationshipType.ContainsElements]: 'IfcRelContainedInSpatialStructure',
        [RelationshipType.Aggregates]: 'IfcRelAggregates',
        [RelationshipType.DefinesByProperties]: 'IfcRelDefinesByProperties',
        [RelationshipType.DefinesByType]: 'IfcRelDefinesByType',
        [RelationshipType.AssociatesMaterial]: 'IfcRelAssociatesMaterial',
        [RelationshipType.AssociatesClassification]: 'IfcRelAssociatesClassification',
        [RelationshipType.AssociatesDocument]: 'IfcRelAssociatesDocument',
        [RelationshipType.VoidsElement]: 'IfcRelVoidsElement',
        [RelationshipType.FillsElement]: 'IfcRelFillsElement',
        [RelationshipType.ConnectsPathElements]: 'IfcRelConnectsPathElements',
        [RelationshipType.ConnectsElements]: 'IfcRelConnectsElements',
        [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
        [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
        [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
        [RelationshipType.ReferencedInSpatialStructure]: 'ReferencedInSpatialStructure',
    };
    return names[type] || 'Unknown';
}
