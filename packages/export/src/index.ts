/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/export - Export formats
 */

// GLTFExporter removed — glTF/GLB is now assembled in Rust (ifc-lite-export).
// Use GeometryProcessor.exportGlb (from bytes) / exportGlbFromMeshes (from meshes).
export { ParquetExporter, type ParquetExportOptions } from './parquet-exporter.js';
// CSVExporter removed — CSV is now produced in Rust (ifc-lite-export).
// Use GeometryProcessor.exportCsv(bytes, mode, …) — mode ∈ entities|properties|quantities|spatial.
// JSONLDExporter removed — JSON-LD is now produced in Rust (ifc-lite-export).
// Use GeometryProcessor.exportJsonld(bytes, …).
export { StepExporter, exportToStep, type StepExportOptions, type StepExportResult, type StepExportProgress } from './step-exporter.js';
export { MergedExporter, type MergeModelInput, type MergeExportOptions, type MergeExportResult, type ExportProgress } from './merged-exporter.js';
export { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
export { convertEntityType, convertStepLine, needsConversion, describeConversion, type IfcSchemaVersion } from './schema-converter.js';
export { Ifc5Exporter, IFC5_KNOWN_PROP_NAMES, type Ifc5ExportOptions, type Ifc5ExportResult } from './ifc5-exporter.js';

// LOD geometry generators (contributed by madsik)
export type { Vec3, LodInput, Lod0Element, Lod0Json, Lod1MetaJson, GenerateLod1Result } from './lod-geometry-types.js';
export { generateLod0 } from './lod0-generator.js';
export { generateLod1, type GenerateLod1Options } from './lod1-generator.js';
export { parseGLB, extractGlbMapping, parseGLBToMeshData, countGlbMeshes } from './glb.js';
