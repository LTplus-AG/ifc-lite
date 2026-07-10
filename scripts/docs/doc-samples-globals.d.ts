/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambient globals for doc code samples (see check-doc-samples.mjs).
 *
 * Doc snippets are written for readability, not to be self-contained, so
 * they use conventional free variables (`store`, `query`, `renderer`) and
 * type names carried over from an earlier snippet's imports. This file
 * gives each of them its REAL @ifc-lite type so every API call made
 * against them is typechecked for real — the point is to catch renamed
 * exports and changed signatures, not to make the snippets runnable.
 *
 * Rule: keep the types real. Never widen an @ifc-lite name to `any` just
 * to silence an error, or the check stops guarding the API. (Third-party
 * and glue names — three, babylon, `saveFile` — live in
 * doc-samples-externals.d.ts, where `any` is fine because they are not
 * part of the surface under test.)
 */

import type {
  IfcParser as _IfcParser,
  IfcDataStore as _IfcDataStore,
  ParseResult as _ParseResult,
  ParseOptions as _ParseOptions,
  WasmScanApi as _WasmScanApi,
  PreScannedEntityIndex as _PreScannedEntityIndex,
  EntityRef as _EntityRef,
  extractEntityAttributesOnDemand as _extractEntityAttributesOnDemand,
  extractPropertiesOnDemand as _extractPropertiesOnDemand,
  extractQuantitiesOnDemand as _extractQuantitiesOnDemand,
} from '@ifc-lite/parser';
import type {
  StringTable as _StringTable,
  EntityTable as _EntityTable,
  PropertyTable as _PropertyTable,
  QuantityTable as _QuantityTable,
  RelationshipGraph as _RelationshipGraph,
  SpatialHierarchy as _SpatialHierarchy,
} from '@ifc-lite/data';
import type {
  GeometryProcessor as _GeometryProcessor,
  GeometryResult as _GeometryResult,
  MeshData as _MeshData,
} from '@ifc-lite/geometry';
import type { IfcQuery as _IfcQuery } from '@ifc-lite/query';
import type { Renderer as _Renderer } from '@ifc-lite/renderer';
import type { StepExporter as _StepExporter } from '@ifc-lite/export';
import type {
  MutablePropertyView as _MutablePropertyView,
  StoreEditor as _StoreEditor,
} from '@ifc-lite/mutations';
import type { IfcServerClient as _IfcServerClient } from '@ifc-lite/server-client';
import type { SpatialIndex as _SpatialIndex } from '@ifc-lite/spatial';
import type {
  BimContext as _BimContext,
  EntityRef as _SdkEntityRef,
  BimBackend as _BimBackend,
  Transport as _SdkTransport,
} from '@ifc-lite/sdk';
import type {
  ViewerCameraState as _ViewerCameraState,
  ViewerSectionPlane as _ViewerSectionPlane,
  BCFViewpoint as _BCFViewpoint,
  IDSReportInput as _IDSReportInput,
  IDSBCFExportOptions as _IDSBCFExportOptions,
} from '@ifc-lite/bcf';
import type {
  ClashEngine as _ClashEngine,
  ClashElement as _ClashElement,
  ClashRule as _ClashRule,
  ClashResult as _ClashResult,
  ClashGroup as _ClashGroup,
  Clash as _Clash,
  ClashReviewStatus as _ClashReviewStatus,
  ExclusionSet as _ExclusionSet,
} from '@ifc-lite/clash';
import type {
  IDSDocument as _IDSDocument,
  IFCDataAccessor as _IFCDataAccessor,
  IDSModelInfo as _IDSModelInfo,
  validateIDS as _validateIDS,
} from '@ifc-lite/ids';
import type {
  EntityFingerprint as _EntityFingerprint,
  diffModels as _diffModels,
} from '@ifc-lite/diff';
import type { LensDataProvider as _LensDataProvider } from '@ifc-lite/lens';
import type { ListDataProvider as _ListDataProvider } from '@ifc-lite/lists';
import type { MCPServer as _MCPServer } from '@ifc-lite/mcp';
import type {
  SectionPlane as _SectionPlane,
  Vec3 as _RendererVec3,
  RenderPipeline as _RenderPipeline,
  Camera as _Camera,
} from '@ifc-lite/renderer';
import type {
  AABB as _SpatialAABB,
  Frustum as _SpatialFrustum,
} from '@ifc-lite/spatial';
import type {
  Drawing2D as _Drawing2D,
  OpeningInfo as _OpeningInfo,
  Bounds2D as _Bounds2D,
  Point2D as _Point2D,
  SectionPlaneConfig as _SectionPlaneConfig,
} from '@ifc-lite/drawing-2d';
import type {
  IfcAPI as _IfcAPI,
  MeshCollection as _MeshCollection,
} from '@ifc-lite/wasm';

declare global {
  // --- Real @ifc-lite type names carried over from earlier snippets ---
  type IfcDataStore = _IfcDataStore;
  type ParseResult = _ParseResult;
  type ParseOptions = _ParseOptions;
  type WasmScanApi = _WasmScanApi;
  type PreScannedEntityIndex = _PreScannedEntityIndex;
  type EntityRef = _EntityRef;
  type StringTable = _StringTable;
  type EntityTable = _EntityTable;
  type PropertyTable = _PropertyTable;
  type QuantityTable = _QuantityTable;
  type RelationshipGraph = _RelationshipGraph;
  type SpatialHierarchy = _SpatialHierarchy;
  type MeshData = _MeshData;
  type GeometryResult = _GeometryResult;
  type SpatialIndex = _SpatialIndex;
  type IfcParser = _IfcParser;
  type IfcQuery = _IfcQuery;
  type Renderer = _Renderer;
  type GeometryProcessor = _GeometryProcessor;
  type StepExporter = _StepExporter;

  // --- On-demand extractors used unqualified (continuation snippets) ---
  const extractEntityAttributesOnDemand: typeof _extractEntityAttributesOnDemand;
  const extractPropertiesOnDemand: typeof _extractPropertiesOnDemand;
  const extractQuantitiesOnDemand: typeof _extractQuantitiesOnDemand;

  // --- Class constructors used unqualified (continuation snippets) ---
  const IfcParser: typeof _IfcParser;
  const IfcQuery: typeof _IfcQuery;
  const Renderer: typeof _Renderer;
  const GeometryProcessor: typeof _GeometryProcessor;
  const StepExporter: typeof _StepExporter;

  // --- Browser / raw input handles ---------------------------------
  const canvas: HTMLCanvasElement;
  const file: File;
  const buffer: ArrayBuffer;
  const arrayBuffer: ArrayBuffer;
  const zipBuffer: ArrayBuffer;
  const bytes: Uint8Array;
  const expressSource: string;
  const csvString: string;
  const idsXmlContent: string;

  // --- Parsed models -----------------------------------------------
  const store: _IfcDataStore;
  const dataStore: _IfcDataStore;
  const store1: _IfcDataStore;
  const store2: _IfcDataStore;
  const parseResult: _ParseResult;

  // --- Geometry ----------------------------------------------------
  const geometryResult: _GeometryResult;
  const result: _GeometryResult;
  const meshes: _MeshData[];
  const meshDataByExpressId: Map<number, _MeshData>;

  // --- Long-lived instances ----------------------------------------
  const parser: _IfcParser;
  const renderer: _Renderer;
  const query: _IfcQuery;
  const processor: _GeometryProcessor;
  const gp: _GeometryProcessor;
  const exporter: _StepExporter;
  const editor: _StoreEditor;
  const mutationView: _MutablePropertyView;
  const view: _MutablePropertyView;
  const propertyTable: _PropertyTable;
  const entityTable: _EntityTable;
  const hierarchy: _SpatialHierarchy;
  const spatialIndex: _SpatialIndex;
  const client: _IfcServerClient;
  const bim: _BimContext;

  // --- Ids and small scalars ---------------------------------------
  const wallExpressId: number;
  const wallId: number;
  const wallIds: number[];
  const expressId: number;
  const entityId: number;
  const storeyId: number;
  const storeyExpressId: number;
  const spaceId: number;
  const openingId: number;
  const elementId: number;
  const unwantedExpressId: number;
  const unwantedRef: _SdkEntityRef;
  const modelId: string;
  const x: number;
  const y: number;

  // --- Visibility sets (reassigned in some snippets, hence `var`) ---
  var hiddenIds: Set<number>;
  var isolatedIds: Set<number> | null;
  var hiddenSet: Set<number>;
  var isolatedSet: Set<number>;
  var selectedIds: Set<number>;

  // --- Mutations returned from an earlier edit ---------------------
  const mutation1: ReturnType<_MutablePropertyView['setProperty']>;
  const mutation2: ReturnType<_MutablePropertyView['setProperty']>;

  // --- Type names quoted in interface-documentation fences ---------
  type SectionPlane = _SectionPlane;
  type Vec3 = _RendererVec3;
  type AABB = _SpatialAABB;
  type Frustum = _SpatialFrustum;
  type IfcAPI = _IfcAPI;
  type MeshCollection = _MeshCollection;

  // --- Functions used unqualified in continuation fences -----------
  const validateIDS: typeof _validateIDS;
  const diffModels: typeof _diffModels;
  const IfcAPI: typeof _IfcAPI;

  // --- BCF (docs/guide/bcf.md) --------------------------------------
  const bcfBuffer: ArrayBuffer;
  const currentCameraState: _ViewerCameraState;
  const selectedGuids: string[];
  const hiddenGuids: string[];
  const visibleGuids: string[];
  const activePlane: _ViewerSectionPlane;
  const base64Image: string;
  const viewpoint: _BCFViewpoint;
  const guid: string;
  const reportInput: _IDSReportInput;
  const options: _IDSBCFExportOptions;

  // --- Clash detection (docs/guide/clash-detection.md, bcf.md) ------
  const engine: _ClashEngine;
  const rules: _ClashRule[];
  const elements: _ClashElement[];
  const exclusions: _ExclusionSet;
  const clash: _Clash;
  const members: _Clash[];
  const clashResult: _ClashResult;
  const groups: _ClashGroup[];
  const reviews: Map<string, { status: _ClashReviewStatus; comment?: string }>;
  const myReviews: Map<string, { status: _ClashReviewStatus; comment?: string }>;
  const ductBounds: _SpatialAABB;
  const ductPositions: Float32Array;
  const ductIndices: Uint32Array;

  // --- IDS (docs/guide/ids.md) --------------------------------------
  const idsXmlString: string;
  const idsXml: string;
  const idsDocument: _IDSDocument;
  const accessor: _IFCDataAccessor;
  const modelInfo: _IDSModelInfo;

  // --- Federation buffers (docs/guide/federation.md) ------------------
  const archBuffer: ArrayBuffer;
  const structBuffer: ArrayBuffer;
  const baseBuffer: ArrayBuffer;
  const overlayBuffer: ArrayBuffer;

  // --- Model diff (docs/guide/model-diff.md) -------------------------
  const baseFingerprints: _EntityFingerprint[];
  const headFingerprints: _EntityFingerprint[];
  const base: _EntityFingerprint[];
  const head: _EntityFingerprint[];

  // --- Lens / Lists data provider (docs/guide/lens.md, lists.md) -----
  // One `provider` var serves both guides; the intersection keeps each
  // guide's calls checked against its own real provider interface.
  const provider: _LensDataProvider & _ListDataProvider;

  // --- Scripting SDK (docs/guide/scripting-sdk.md) -------------------
  const myLocalBackend: _BimBackend;
  const myBroadcastTransport: _SdkTransport;
  const refs: _SdkEntityRef[];

  // --- MCP (docs/guide/mcp.md) ---------------------------------------
  const server: _MCPServer;

  // --- Collab (docs/guide/collab.md) ----------------------------------
  const ifcxContent: string;

  // --- Server buffers (docs/guide/server.md) ---------------------------
  const parquetBuffer: ArrayBuffer;
  const dataModelBuffer: ArrayBuffer;

  // --- WASM boundary (docs/guide/error-handling.md) --------------------
  // Real parameter tuple of processGeometryBatch, so `api.processGeometryBatch(...args)`
  // stays signature-checked without the doc spelling out all 16 arguments.
  const args: Parameters<_IfcAPI['processGeometryBatch']>;

  // --- Rendering (docs/guide/rendering.md) -----------------------------
  const modelBounds: { min: _RendererVec3; max: _RendererVec3 };
  const sectionPlane: _SectionPlane;
  const pipeline: _RenderPipeline;
  const deltaX: number;
  const deltaY: number;
  const delta: number;
  const storeyElevation: number;
  const storeyHeight: number;
  const id1: number;
  const id2: number;
  const id3: number;
  const entity1: _EntityRef;
  const entity2: _EntityRef;
  const doorId: number;

  // --- 2D drawings (docs/guide/drawing-2d.md) --------------------------
  const meshData: _MeshData[];
  const drawing: _Drawing2D;
  const opening: _OpeningInfo;
  const bounds2D: _Bounds2D;
  const wallDirection: _Point2D;
  const sectionConfig: _SectionPlaneConfig;
  const maxTriangles: number;
}

export {};
