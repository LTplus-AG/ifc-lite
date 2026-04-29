/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parquet exporter for ara3d BOS-compatible format
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcTypeEnumToString, IfcTypeEnum, EntityFlags, PropertyValueType, QuantityType, RelationshipType } from '@ifc-lite/data';

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

    constructor(store: IfcDataStore, geometryResult?: GeometryResult) {
        this.store = store;
        this.geometryResult = geometryResult;
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

        return this.toParquet({
            ExpressId: Array.from(entities.expressId),
            GlobalId: mapTypedArray(entities.globalId, i => strings.get(i)),
            Name: mapTypedArray(entities.name, i => strings.get(i)),
            Description: mapTypedArray(entities.description, i => strings.get(i)),
            Type: mapTypedArray(entities.typeEnum, i => IfcTypeEnumToString(i)),
            ObjectType: mapTypedArray(entities.objectType, i => strings.get(i)),
            HasGeometry: mapTypedArray(entities.flags, f => (f & EntityFlags.HAS_GEOMETRY) !== 0),
            IsType: mapTypedArray(entities.flags, f => (f & EntityFlags.IS_TYPE) !== 0),
            ContainedInStorey: Array.from(entities.containedInStorey),
            DefinedByType: Array.from(entities.definedByType),
            GeometryIndex: Array.from(entities.geometryIndex),
        });
    }

    private async writeProperties(): Promise<Uint8Array> {
        const { properties, strings } = this.store;

        return this.toParquet({
            EntityId: Array.from(properties.entityId),
            PsetName: mapTypedArray(properties.psetName, i => strings.get(i)),
            PsetGlobalId: mapTypedArray(properties.psetGlobalId, i => strings.get(i)),
            PropName: mapTypedArray(properties.propName, i => strings.get(i)),
            PropType: mapTypedArray(properties.propType, t => PropertyValueTypeToString(t)),
            ValueString: mapTypedArray(properties.valueString, i => i >= 0 && i < strings.count ? strings.get(i) : null),
            ValueReal: Array.from(properties.valueReal),
            ValueInt: Array.from(properties.valueInt),
            ValueBool: mapTypedArray(properties.valueBool, v => v === 255 ? null : v === 1),
        });
    }

    private async writeQuantities(): Promise<Uint8Array> {
        const { quantities, strings } = this.store;

        return this.toParquet({
            EntityId: Array.from(quantities.entityId),
            QsetName: mapTypedArray(quantities.qsetName, i => strings.get(i)),
            QuantityName: mapTypedArray(quantities.quantityName, i => strings.get(i)),
            QuantityType: mapTypedArray(quantities.quantityType, t => QuantityTypeToString(t)),
            Value: Array.from(quantities.value),
            Formula: mapTypedArray(quantities.formula, i => i > 0 ? strings.get(i) : null),
        });
    }

    private async writeRelationships(): Promise<Uint8Array> {
        const { relationships } = this.store;
        const edges = relationships.forward;

        // Flatten CSR format to row-based
        const sourceIds: number[] = [];
        const targetIds: number[] = [];
        const relTypes: string[] = [];
        const relIds: number[] = [];

        for (const [sourceId, offset] of edges.offsets) {
            const count = edges.counts.get(sourceId)!;
            for (let i = offset; i < offset + count; i++) {
                sourceIds.push(sourceId);
                targetIds.push(edges.edgeTargets[i]);
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

        // Collect all positions and normals from meshes
        const allPositions: number[] = [];
        const allNormals: number[] = [];

        for (const mesh of this.geometryResult.meshes) {
            allPositions.push(...Array.from(mesh.positions));
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

        // Collect all indices from meshes
        const allIndices: number[] = [];
        for (const mesh of this.geometryResult.meshes) {
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
        const expressIds: number[] = [];
        const vertexStarts: number[] = [];
        const vertexCounts: number[] = [];
        const indexStarts: number[] = [];
        const indexCounts: number[] = [];

        let vertexOffset = 0;
        let indexOffset = 0;

        for (const mesh of meshes) {
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

    private async toParquet(columns: Record<string, any[]>): Promise<Uint8Array> {
        try {
            // Dynamic imports for better tree-shaking. The package's
            // browser/node exports map keeps `Arrow.dom.mjs` opaque to
            // TS5's strict resolver, so the import is typed `any` here
            // and consumers fall back to runtime checks. See:
            // https://github.com/apache/arrow/issues/35835
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const arrow: any = await import('apache-arrow');

            // Build Arrow vectors from column data
            const vectors: Record<string, any> = {};

            for (const [name, data] of Object.entries(columns)) {
                if (data.length === 0) {
                    // Empty column - create empty vector with null type
                    vectors[name] = arrow.vectorFromArray([]);
                    continue;
                }

                // Infer type from first non-null element
                const sample = data.find((v) => v !== null && v !== undefined);

                if (sample === undefined) {
                    // All nulls - create string vector with nulls
                    vectors[name] = arrow.vectorFromArray(data);
                } else if (typeof sample === 'number') {
                    // Check if it's integer or float
                    const isFloat = data.some((v) => typeof v === 'number' && !Number.isInteger(v));
                    if (isFloat) {
                        vectors[name] = arrow.vectorFromArray(data, new arrow.Float64());
                    } else {
                        // Use Int32 for integers (covers express IDs and most counts)
                        vectors[name] = arrow.vectorFromArray(data, new arrow.Int32());
                    }
                } else if (typeof sample === 'boolean') {
                    vectors[name] = arrow.vectorFromArray(data, new arrow.Bool());
                } else {
                    // String or other - convert to string
                    vectors[name] = arrow.vectorFromArray(data.map((v) => v === null ? null : String(v)));
                }
            }

            // Build Arrow Table
            const table = new arrow.Table(vectors);

            // Convert to Arrow IPC format
            const ipcBuffer = arrow.tableToIPC(table, 'stream');

            // Try to use parquet-wasm for conversion
            try {
                const parquet = await import('parquet-wasm');

                // parquet-wasm 0.5+ API: read Arrow IPC and write Parquet
                const arrowTable = parquet.Table.fromIPCStream(ipcBuffer);
                const parquetBuffer = parquet.writeParquet(arrowTable);

                return new Uint8Array(parquetBuffer);
            } catch (parquetError) {
                // Fallback: If parquet-wasm fails, return Arrow IPC format instead
                // This is still a valid binary format that can be read by many tools
                console.warn('[ParquetExporter] parquet-wasm conversion failed, returning Arrow IPC format:', parquetError);
                return new Uint8Array(ipcBuffer);
            }
        } catch (error) {
            // If all else fails, throw a descriptive error
            throw new Error(`Failed to convert to Parquet format: ${error}. Ensure apache-arrow and parquet-wasm are installed.`);
        }
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
