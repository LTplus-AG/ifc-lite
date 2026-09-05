/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-model load report (issue #3927). Pure functions only — no React, no
 * store reads — so the aggregation/formatting logic is unit-testable without
 * mounting a component.
 *
 * The report presents EXISTING evidence only: the `GeometryDiagnostics`
 * contract (`@ifc-lite/geometry`) already carried on `FederatedModel.diagnostics`,
 * plus the load-time metadata `useIfcLoader` attaches alongside it. It never
 * infers complete geometry from an absent diagnostics object, and never
 * invents an entity identity the diagnostic contract did not supply:
 *
 *  - `worstHosts` carries a `productId` + `ifcType` per host, so those become
 *    `affectedEntities` (selectable/frameable when a `bbox` was captured).
 *  - `unsupportedItemsByType` / `failuresByReason` carry only a reason string
 *    and a count — no identity — so they surface as aggregate actionable text,
 *    never as a fabricated entity row.
 */

import type { GeometryDiagnostics, TessellationQuality } from '@ifc-lite/geometry';
import type { FederatedModel } from '../store/types';
import { buildExportFilename, downloadFile } from './export/download';

/**
 * Load-report fields `FederatedModel` mixes in (`types.ts extends` this) —
 * kept here, next to the code that reads them, so `types.ts` only carries a
 * one-line `extends` rather than the doc comments (module-size budget).
 */
export interface ModelLoadReportFields {
  /** CSG/opening diagnostics for this load. `undefined`/`null` = this load
   *  path never captured diagnostics (cache hit, server, GLB, IFCX) — reads
   *  as "unavailable", never as "clean". */
  diagnostics?: GeometryDiagnostics | null;
  /** Format resolved for this load ('ifc' | 'glb' | 'ifcx' | a point-cloud format). */
  loadFormat?: string;
  /** Pipeline that produced this load; mirrors `captureModelLoaded`'s `load_path`. */
  loadPath?: 'wasm' | 'cache' | 'server' | 'point-cloud';
  /** Tessellation tier actually used; `undefined` = engine default, or not
   *  applicable (the server path always runs full fidelity). */
  tessellationTier?: TessellationQuality;
  /** Whether small-cut skipping (fast geometry mode) ran; `undefined` where
   *  the setting does not apply, not a claim that it was off. */
  skipSmallCuts?: boolean;
}

/**
 * Build `ModelLoadReportFields` for a `FederatedModel` write. Shared by
 * `finalizeModel`'s two write sites (`useIfcLoader.ts`) so they cannot drift.
 * `loadDiagnostics`/`format` come from that hook's outer closure (assigned
 * before every call site, so no TDZ hazard); `tessellationTier`/`skipSmallCuts`
 * are per-call-site because they genuinely don't apply on some paths
 * (server/GLB/IFCX/point-cloud) and are declared well below some call sites
 * in that closure (the same TDZ hazard `instancedShards` documents there).
 */
export function buildModelLoadReportPatch(
  loadDiagnostics: GeometryDiagnostics | null,
  format: string,
  patch?: Pick<ModelLoadReportFields, 'loadPath' | 'tessellationTier' | 'skipSmallCuts'>,
): ModelLoadReportFields {
  return {
    diagnostics: loadDiagnostics,
    loadFormat: format,
    loadPath: patch?.loadPath,
    tessellationTier: patch?.tessellationTier,
    skipSmallCuts: patch?.skipSmallCuts,
  };
}

/** One diagnostic-contract host, promoted to a report row with an identity a
 *  viewer selection can resolve (global expressId), if the host is renderable. */
export interface LoadReportAffectedEntity {
  /** Original (pre-federation-offset) expressId, as the diagnostics carried it. */
  productId: number;
  /** `productId + model.idOffset` — the id the viewer's selection/hierarchy
   *  APIs expect (see AGENTS.md: "resolve selections/IDs through
   *  FederationRegistry"). */
  globalId: number;
  ifcType: string;
  csgFailures: number;
  openings: number;
  firstFailureLabel?: string;
  /**
   * True only when the diagnostic host carried a captured `bbox` — the
   * signal that its mesh is present and can be framed in 3D. `false` means
   * "show the source identity only": the entity may have no surviving
   * geometry to select and frame (per the issue's boundary, never invented).
   */
  renderable: boolean;
}

export interface LoadReportSummary {
  modelId: string;
  name: string;
  schemaVersion: string;
  sourceFileName: string | undefined;
  fileSize: number;
  loadedAt: number;
  loadFormat: string | undefined;
  loadPath: string | undefined;
  tessellationTier: string | undefined;
  skipSmallCuts: boolean | undefined;
  /** False = this load path never captured diagnostics ("unavailable"),
   *  never conflated with a load that captured diagnostics and found nothing. */
  diagnosticsAvailable: boolean;
  diagnostics: GeometryDiagnostics | null;
  /** Actionable, human-readable lines — each names what happened AND what a
   *  user can do about it. Empty when nothing diagnostic-worthy was found. */
  actions: string[];
  affectedEntities: LoadReportAffectedEntity[];
  /** True only when diagnostics were captured AND report nothing: the
   *  "quiet report" state distinct from "unavailable". */
  isClean: boolean;
}

function buildActions(model: FederatedModel, d: GeometryDiagnostics | null): string[] {
  const actions: string[] = [];
  if (d) {
    if (d.totalCsgFailures > 0) {
      actions.push(
        `${d.totalCsgFailures} CSG failure(s) across ${d.productsWithFailures} product(s) — ` +
          'openings may be missing or mis-cut; see the affected entities below.',
      );
    }
    if (d.silentNoOps > 0) {
      actions.push(
        `${d.silentNoOps} host(s) had a rectangular cut attempted with no visible change — ` +
          'verify these openings manually.',
      );
    }
    if ((d.totalUnsupportedItems ?? 0) > 0) {
      const byType = (d.unsupportedItemsByType ?? []).map((r) => `${r.count} ${r.reason}`).join(', ');
      actions.push(
        `${d.totalUnsupportedItems} representation item(s) were dropped (unsupported type or ` +
          `failed geometry)${byType ? `: ${byType}` : ''} — these elements are missing or ` +
          'incomplete in the 3D view.',
      );
    }
    if ((d.oversizedRefDrops ?? 0) > 0) {
      actions.push(
        `${d.oversizedRefDrops} content-hash reference(s) were skipped (exceeded the hashing ` +
          'limit) — some repeated geometry instances may be missing.',
      );
    }
  }
  if (model.skipSmallCuts) {
    actions.push(
      'Loaded in fast geometry mode (small cuts skipped) — small openings may be missing; ' +
        'reload in full-fidelity mode for complete geometry.',
    );
  }
  if (model.tessellationTier === 'lowest') {
    actions.push(
      'Loaded at the lowest tessellation tier — curved surfaces are coarser than the source geometry.',
    );
  }
  return actions;
}

function buildAffectedEntities(model: FederatedModel, d: GeometryDiagnostics | null): LoadReportAffectedEntity[] {
  if (!d) return [];
  return d.worstHosts.map((h) => ({
    productId: h.productId,
    globalId: h.productId + model.idOffset,
    ifcType: h.ifcType,
    csgFailures: h.csgFailures,
    openings: h.openings,
    firstFailureLabel: h.firstFailureLabel,
    renderable: h.bbox !== undefined,
  }));
}

/** Build a report for one loaded model. Never throws; a model with no
 *  captured diagnostics reports `diagnosticsAvailable: false`, not a clean
 *  zero-count report. */
export function buildLoadReport(model: FederatedModel): LoadReportSummary {
  const d = model.diagnostics ?? null;
  const diagnosticsAvailable = d != null;
  const actions = buildActions(model, d);
  const affectedEntities = buildAffectedEntities(model, d);
  return {
    modelId: model.id,
    name: model.name,
    schemaVersion: model.schemaVersion,
    sourceFileName: model.sourceFile?.name,
    fileSize: model.fileSize,
    loadedAt: model.loadedAt,
    loadFormat: model.loadFormat,
    loadPath: model.loadPath,
    tessellationTier: model.tessellationTier,
    skipSmallCuts: model.skipSmallCuts,
    diagnosticsAvailable,
    diagnostics: d,
    actions,
    affectedEntities,
    isClean: diagnosticsAvailable && actions.length === 0 && affectedEntities.length === 0,
  };
}

/** Build every loaded model's report, in the map's iteration order. */
export function buildLoadReports(models: ReadonlyMap<string, FederatedModel>): LoadReportSummary[] {
  return Array.from(models.values()).map(buildLoadReport);
}

/** JSON-exportable plain object for one or more reports (issue #3927's
 *  "JSON export for reproduction reports"). */
export function buildLoadReportJSON(reports: readonly LoadReportSummary[]): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    models: reports.map((r) => ({
      modelId: r.modelId,
      name: r.name,
      schemaVersion: r.schemaVersion,
      sourceFileName: r.sourceFileName,
      fileSize: r.fileSize,
      loadedAt: new Date(r.loadedAt).toISOString(),
      loadFormat: r.loadFormat,
      loadPath: r.loadPath,
      tessellationTier: r.tessellationTier,
      skipSmallCuts: r.skipSmallCuts,
      diagnosticsAvailable: r.diagnosticsAvailable,
      diagnostics: r.diagnostics,
      actions: r.actions,
      affectedEntities: r.affectedEntities,
      isClean: r.isClean,
    })),
  };
}

/** Trigger a JSON download of the given reports, through the one sanctioned
 *  export path (`lib/export/download.ts`). */
export function downloadLoadReportJSON(reports: readonly LoadReportSummary[]): void {
  const data = buildLoadReportJSON(reports);
  const filename = buildExportFilename('model-load-report', 'json');
  downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
}
