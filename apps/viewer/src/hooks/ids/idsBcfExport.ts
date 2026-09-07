/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS -> BCF export pipeline: entity bounds collection, optional per-entity
 * snapshot capture, BCF project assembly, and the file write/download. Pulled
 * out of `useIDS`'s `exportReportBCF` callback — the logic reads/writes the
 * viewer store and renderer directly, so it isn't a "pure" function, but it
 * has exactly one entry point and no other caller, which is what makes it a
 * coherent module on its own rather than 230 lines inline in the hook.
 */

import type { IDSValidationReport } from '@ifc-lite/ids';
import type { EntityBoundsInput, IDSBCFExportOptions } from '@ifc-lite/bcf';
import { createBCFFromIDSReport, writeBCF } from '@ifc-lite/bcf';
import type { GeometryResult } from '@ifc-lite/geometry';
import { downloadBlob } from '@/lib/export/download';
import { getEntityBounds } from '@/utils/viewportUtils';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useViewerStore, type FederatedModel } from '@/store';
import type { IDSBCFExportSettings, IDSExportProgress } from '@/components/viewer/IDSExportDialog';

const SNAPSHOT_CLEAR_COLOR: [number, number, number, number] = [0.102, 0.106, 0.149, 1];

export interface RunIdsBcfExportParams {
  report: IDSValidationReport;
  settings: IDSBCFExportSettings;
  models: Map<string, FederatedModel>;
  /** The legacy single-model geometry result, read via a ref in the caller. */
  legacyGeometryResult: GeometryResult | null;
  toViewerGlobalId: (modelId: string, expressId: number) => number | undefined;
  bcfAuthor: string | undefined;
  setBcfExportProgress: (progress: IDSExportProgress | null) => void;
  setBcfProject: (project: ReturnType<typeof createBCFFromIDSReport>) => void;
  setBcfPanelVisible: (visible: boolean) => void;
}

/**
 * Runs the full IDS-report-to-BCF export: collects entity bounds, optionally
 * captures a snapshot per failing (and, if requested, passing) entity, builds
 * the BCF project, writes it, downloads it, and optionally loads it into the
 * BCF panel. Throws on failure — the caller is responsible for catching and
 * surfacing the error (and for resetting export progress on catch).
 */
export async function runIdsBcfExport({
  report,
  settings,
  models,
  legacyGeometryResult,
  toViewerGlobalId,
  bcfAuthor,
  setBcfExportProgress,
  setBcfProject,
  setBcfPanelVisible,
}: RunIdsBcfExportParams): Promise<void> {
  const {
    topicGrouping,
    includePassingEntities,
    includeCamera,
    includeSnapshots,
    loadIntoBcfPanel,
  } = settings;

  // Phase 1: Collect entity bounds (needed for both camera and snapshots)
  let entityBounds: Map<string, EntityBoundsInput> | undefined;

  if (includeCamera || includeSnapshots) {
    setBcfExportProgress({ phase: 'building', current: 0, total: 1, message: 'Computing entity bounds...' });

    entityBounds = new Map();
    const geomResult = legacyGeometryResult;

    // Collect geometry from all models
    const allMeshData: Array<{ meshes: unknown[]; idOffset: number; modelId: string }> = [];
    for (const [modelId, model] of models.entries()) {
      if (model.geometryResult?.meshes) {
        allMeshData.push({
          meshes: model.geometryResult.meshes,
          idOffset: model.idOffset ?? 0,
          modelId,
        });
      }
    }

    // Also include legacy single-model geometry
    if (geomResult?.meshes && allMeshData.length === 0) {
      allMeshData.push({
        meshes: geomResult.meshes,
        idOffset: 0,
        modelId: 'default',
      });
    }

    // Compute bounds for each entity that appears in the report
    for (const specResult of report.specificationResults) {
      for (const entity of specResult.entityResults) {
        if (entity.passed && !includePassingEntities) continue;
        const boundsKey = `${entity.modelId}:${entity.expressId}`;
        if (entityBounds.has(boundsKey)) continue;

        // Find matching model geometry
        for (const modelData of allMeshData) {
          if (modelData.modelId === entity.modelId || allMeshData.length === 1) {
            const globalExpressId = toViewerGlobalId(entity.modelId, entity.expressId);
            if (globalExpressId == null) break;
            const bounds = getEntityBounds(
              modelData.meshes as Parameters<typeof getEntityBounds>[0],
              globalExpressId,
            );
            if (bounds) {
              entityBounds.set(boundsKey, bounds);
            }
            break;
          }
        }
      }
    }
  }

  // Phase 2: Batch snapshots if requested
  let entitySnapshots: Map<string, string> | undefined;

  if (includeSnapshots) {
    entitySnapshots = new Map();

    // Get renderer for direct rendering control (no selection highlight)
    const renderer = getGlobalRenderer();
    if (!renderer) {
      console.warn('[IDS] No renderer available for snapshot capture');
    } else {
      const camera = renderer.getCamera();

      // Collect all unique entities that need snapshots (Set-based O(1) dedup)
      const seenKeys = new Set<string>();
      const entitiesToSnapshot: Array<{ modelId: string; expressId: number; boundsKey: string }> = [];
      for (const specResult of report.specificationResults) {
        for (const entity of specResult.entityResults) {
          if (entity.passed && !includePassingEntities) continue;
          const boundsKey = `${entity.modelId}:${entity.expressId}`;
          if (!seenKeys.has(boundsKey)) {
            seenKeys.add(boundsKey);
            entitiesToSnapshot.push({
              modelId: entity.modelId,
              expressId: entity.expressId,
              boundsKey,
            });
          }
        }
      }

      const total = entitiesToSnapshot.length;

      // Save current viewer state to restore after snapshot batch
      const storeState = useViewerStore.getState();
      const savedSelection = storeState.selectedEntityId;
      const savedIsolation = storeState.isolatedEntities;
      const savedHidden = storeState.hiddenEntities;

      for (let i = 0; i < total; i++) {
        const entity = entitiesToSnapshot[i];
        setBcfExportProgress({
          phase: 'snapshots',
          current: i + 1,
          total,
          message: `Capturing snapshot ${i + 1}/${total}...`,
        });

        // Get the entity's bounds for framing
        const bounds = entityBounds?.get(entity.boundsKey);
        if (!bounds) continue;

        // Find the global expressId for isolation (direct Map lookup)
        const globalExpressId = toViewerGlobalId(entity.modelId, entity.expressId);
        if (globalExpressId == null) continue;

        // Frame the entity bounds directly via camera (properly centers the object)
        // duration=1 (not 0) because the animator skips updates when duration===0,
        // causing the camera to never move. 1ms is effectively instant.
        await camera.frameBounds(bounds.min, bounds.max, 1);

        // Render with: entity isolated, NO selection highlight (no cyan), IDS colors intact
        const isolationSet = new Set([globalExpressId]);
        renderer.render({
          isolatedIds: isolationSet,
          selectedId: null,           // No cyan selection highlight
          clearColor: SNAPSHOT_CLEAR_COLOR,
          // Isolation may reveal batches evicted under the GPU residency
          // budget — restore them synchronously so the capture is complete.
          restoreEvictedForCapture: true,
        });

        // Wait for GPU commands to complete
        const device = renderer.getGPUDevice();
        if (device) {
          await device.queue.onSubmittedWorkDone();
        }

        // Wait for the browser compositor to present the frame to the canvas.
        // Without this, toDataURL() reads a stale canvas — only the last snapshot
        // would show the entity because previous frames haven't been composited yet.
        // FRAME-WAIT-ALLOW(#2385): must NOT be raced against a timer. The whole
        // point is that the frame was actually presented; timing out would read
        // a stale canvas into the IDS report snapshot. A hidden tab cannot
        // present a frame at all, so bounding this buys nothing.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

        // Capture the now-presented frame
        const dataUrl = await renderer.captureScreenshot();
        if (dataUrl) {
          entitySnapshots.set(entity.boundsKey, dataUrl);
        }
      }

      // Restore viewer state — set store back to saved state directly
      useViewerStore.setState({
        selectedEntityId: savedSelection,
        isolatedEntities: savedIsolation,
        hiddenEntities: savedHidden,
      });

      // Re-render with restored state (original clearColor restored by omitting it)
      renderer.render({
        hiddenIds: savedHidden,
        isolatedIds: savedIsolation,
        selectedId: savedSelection,
      });
    }
  }

  // Phase 3: Build BCF project
  setBcfExportProgress({ phase: 'writing', current: 0, total: 1, message: 'Building BCF project...' });

  const exportOptions: IDSBCFExportOptions = {
    author: bcfAuthor || report.document.info.author || 'ids-validator@ifc-lite',
    projectName: `IDS Report - ${report.document.info.title}`,
    topicGrouping,
    includePassingEntities,
    entityBounds,
    entitySnapshots,
  };

  const bcfProject = createBCFFromIDSReport(
    {
      title: report.document.info.title,
      description: report.document.info.description,
      specificationResults: report.specificationResults,
    },
    exportOptions,
  );

  // Phase 4: Write BCF and download
  setBcfExportProgress({ phase: 'writing', current: 1, total: 2, message: 'Writing BCF file...' });

  const blob = await writeBCF(bcfProject);
  downloadBlob(blob, `ids-report-${new Date().toISOString().split('T')[0]}.bcfzip`);

  // Phase 5: Load into BCF panel if requested
  if (loadIntoBcfPanel) {
    setBcfProject(bcfProject);
    setBcfPanelVisible(true);
  }

  setBcfExportProgress({ phase: 'done', current: 1, total: 1, message: 'Export complete!' });

  // Clear progress after a delay
  setTimeout(() => setBcfExportProgress(null), 2000);
}
