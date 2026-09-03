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
// Anonymized isolated export (#2934): pick a seed selection, expand it by
// relationship context, then export exactly that subset with every
// project-identifying signal removed. See `docs/guide/exporting.md`.
export { collectRelatedEntities } from './related-entities.js';
export { exportAnonymizedSubset } from './anonymize-export.js';
export type {
  RelatedEntityOptions,
  RelatedEntityGroup,
  RelatedEntities,
  AnonymizeOptions,
  AnonymizeResult,
} from './anonymize-types.js';
export { MergedExporter, type MergeModelInput, type MergeExportOptions, type MergeExportResult, type MergeBlobExportResult, type ExportProgress } from './merged-exporter.js';
export { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
export { convertEntityType, convertStepLine, needsConversion, describeConversion, type IfcSchemaVersion } from './schema-converter.js';
export { Ifc5Exporter, IFC5_KNOWN_PROP_NAMES, type Ifc5ExportOptions, type Ifc5ExportResult } from './ifc5-exporter.js';

// LOD geometry generators (contributed by madsik)
export type { Vec3, LodInput, Lod0Element, Lod0Json, Lod1MetaJson, GenerateLod1Result } from './lod-geometry-types.js';
export {
  DemeshSession,
  type DemeshSessionOptions,
  type DemeshSimplifyResult,
  type DemeshExportResult,
} from './demesh-session.js';
export {
  applySimplifiedGeometry,
  type ApplySimplifiedGeometryOptions,
  type DemeshApplyReport,
  type DemeshEditorLike,
  type SimplifiedElementGeometry,
} from './demesh-writer.js';
export { generateLod0 } from './lod0-generator.js';
export { generateLod1, type GenerateLod1Options } from './lod1-generator.js';
export { parseGLB, extractGlbMapping, parseGLBToMeshData, countGlbMeshes } from './glb.js';

export { columnsToParquet, isParquet } from './columns-to-parquet.js';
// THE CSV cell escaper for this repo's TypeScript — RFC 4180 quoting plus the
// CWE-1236 formula-injection guard. Every TS CSV writer (SDK, CLI, MCP, viewer)
// calls this; `scripts/check-csv-escaper-copies.mjs` fails the build on a
// re-inlined copy. Rust's half is `rust/export/src/csv_cell.rs`, pinned to the
// same shared vectors.
// `INVISIBLE_PREFIX_RE` / `PADDING_RE` are deliberately NOT re-exported: they
// are the guard's internals, and the parity suite imports them from the module
// directly. Callers need the two functions and the options type.
export { escapeCsvCell, guardSpreadsheetFormula, type CsvCellOptions } from './csv-cell.js';
