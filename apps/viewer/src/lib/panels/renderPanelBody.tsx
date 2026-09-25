/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single id → panel-component map (#1208 follow-up).
 *
 * The unified sidebar, the floating-panel host (#1201) and the pop-out
 * windows all need to render the *same* panel body for a given id. Keeping
 * the switch here means a panel only has to be wired once, and the three
 * hosts stay in lock-step.
 */

import { lazy, Suspense, type ReactNode } from 'react';
import type { WorkspacePanelId } from './registry';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { HierarchyPanel } from '@/components/viewer/HierarchyPanel';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { ComparePanel } from '@/components/viewer/ComparePanel';
import { BCFPanel } from '@/components/viewer/BCFPanel';
import { ValidationPanel } from '@/components/viewer/validation/ValidationPanel';
import { LensPanel } from '@/components/viewer/LensPanel';
import { ClashPanel } from '@/components/viewer/ClashPanel';
import { ExtensionsPanel } from '@/components/extensions/ExtensionsPanel';
import { ScriptPanel } from '@/components/viewer/ScriptPanel';
import { GanttPanel } from '@/components/viewer/schedule/GanttPanel';
import { ListPanel } from '@/components/viewer/lists/ListPanel';
import { RoomPanel } from '@/components/viewer/RoomPanel';
import { ZonesPanel } from '@/components/viewer/ZonesPanel';
import { LoadReportPanel } from '@/components/viewer/LoadReportPanel';
import { CostPanel } from '@/components/viewer/CostPanel';
import { EnvironmentPanel } from '@/components/viewer/EnvironmentPanel';
import { PointCloudPanel } from '@/components/viewer/PointCloudPanel';
import { useViewerStore } from '@/store';
// Lazy: the Layers panel pulls in @ifc-lite/merge (engine + blake3); a
// dynamic chunk keeps it out of the initial bundle until first opened.
const LayersPanel = lazy(() =>
  import('@/components/viewer/layers/LayersPanel').then((m) => ({ default: m.LayersPanel })),
);
// Lazy: the Sources panel (cloud-source browser + provider plumbing) is only
// needed once a user opens it — keep it out of the first-paint bundle.
const SourcesPanel = lazy(() =>
  import('@/components/sources/SourcesPanel').then((m) => ({ default: m.SourcesPanel })),
);

// Lazy: the Charts panel pulls in ECharts; it stays out of the first-paint bundle.
const ChartsPanel = lazy(() => import('@/components/viewer/charts/ChartsPanel').then((m) => ({ default: m.ChartsPanel })));
const DocumentPanel = lazy(() => import('@/components/viewer/document/DocumentPanel').then((m) => ({ default: m.DocumentPanel })));
// Lazy: the Flow panel pulls in React Flow; it stays out of the first-paint bundle.
const FlowPanel = lazy(() => import('@/components/viewer/flow/FlowPanel').then((m) => ({ default: m.FlowPanel })));
// Lazy: the drawing view pulls in its canvas, export and underlay code; its runtime
// (generation, persistence) is DrawingRuntimeHost, mounted eagerly in ViewportContainer.
const DrawingPanel = lazy(() => import('@/components/viewer/drawing/DrawingPanel').then((m) => ({ default: m.DrawingPanel })));

const AppearancePanel = lazy(() => import('@/components/viewer/appearance/AppearancePanel').then(m => ({ default: m.AppearancePanel })));

// Each lazy panel needs its own stable host identity. Reusing the boundary
// itself as the body can retain another panel's failed-chunk state on a switch.
function AppearancePanelBody() {
  return <ChunkErrorBoundary label="Appearance panel"><Suspense fallback={null}><AppearancePanel /></Suspense></ChunkErrorBoundary>;
}

function DocumentPanelBody() {
  return <ChunkErrorBoundary label="Document panel"><Suspense fallback={null}><DocumentPanel /></Suspense></ChunkErrorBoundary>;
}
function FlowPanelBody() {
  return <ChunkErrorBoundary label="Flow panel"><Suspense fallback={null}><FlowPanel /></Suspense></ChunkErrorBoundary>;
}

function DrawingPanelBody() {
  return <ChunkErrorBoundary label="Drawing panel"><Suspense fallback={null}><DrawingPanel /></Suspense></ChunkErrorBoundary>;
}

function ChartsPanelBody() {
  return <ChunkErrorBoundary label="Charts panel"><Suspense fallback={null}><ChartsPanel /></Suspense></ChunkErrorBoundary>;
}

function LayersPanelBody({ onClose }: { onClose: () => void }) {
  return <ChunkErrorBoundary label="Layers panel"><Suspense fallback={null}><LayersPanel onClose={onClose} /></Suspense></ChunkErrorBoundary>;
}

function SourcesPanelBody({ onClose }: { onClose: () => void }) {
  return <Suspense fallback={null}><SourcesPanel onClose={onClose} /></Suspense>;
}

/**
 * Tiny indirection (formerly `ViewportOverlays`'s `PointCloudPanelMount`,
 * #5507) so the panel can subscribe to its own slice without pulling extra
 * state into every other panel body.
 */
function PointCloudPanelBody({ onClose }: { onClose: () => void }) {
  const assetCount = useViewerStore((s) => s.pointCloudAssetCount);
  // BIM↔scan deviation is a CROSS-MODEL operation: the point cloud is one
  // federated model, the BIM mesh is another. `renderer.computeDeviations()`
  // builds its BVH from EVERY mesh in the scene (`collectAllSceneMeshes`),
  // so the compute button must appear whenever ANY loaded model contributes
  // triangles — not just the active one. Gating on `s.geometryResult` (the
  // ACTIVE model's result) hid the button whenever the point cloud was the
  // active model (its synthetic geometryResult has totalTriangles === 0),
  // which is exactly the common case — so deviation could never be computed
  // and the colour mode showed every point at the ramp centre (grey). Sum
  // across all loaded models to mirror the scene the BVH is actually built from.
  const triangleCount = useViewerStore((s) => {
    let total = 0;
    for (const m of s.models.values()) total += m.geometryResult?.totalTriangles ?? 0;
    return total;
  });
  return <PointCloudPanel assetCount={assetCount} triangleCount={triangleCount} onClose={onClose} />;
}

/**
 * Render the body for a workspace panel. `onClose` is the host's "close this
 * panel" handler (re-dock to Information, remove the float, or re-dock the
 * window). The Information panel ignores it — it is the always-on fallback —
 * and so do the bottom-strip panels (Script / Schedule / Lists / Charts /
 * Document / Flow / Drawing), whose own close row #5498 retired in favour of
 * the strip header's single Close.
 */
export function renderPanelBody(id: WorkspacePanelId, onClose: () => void): ReactNode {
  switch (id) {
    // Hierarchy's home is the left slot (#1267); it is never routed to the right
    // pane / float / pop-out, but the case keeps the id to body map exhaustive.
    case 'appearance': return <AppearancePanelBody />;
    case 'hierarchy': return <HierarchyPanel />;
    case 'properties': return <PropertiesPanel />;
    case 'compare': return <ComparePanel onClose={onClose} />;
    case 'bcf': return <BCFPanel onClose={onClose} />;
    case 'validation': return <ValidationPanel onClose={onClose} />;
    case 'lens': return <LensPanel onClose={onClose} />;
    case 'clash': return <ClashPanel onClose={onClose} />;
    case 'extensions': return <ExtensionsPanel onClose={onClose} />;
    case 'script': return <ScriptPanel />;
    case 'gantt': return <GanttPanel />;
    case 'lists': return <ListPanel />;
    case 'collab': return <RoomPanel onClose={onClose} />;
    case 'zones': return <ZonesPanel onClose={onClose} />;
    case 'loadReport': return <LoadReportPanel onClose={onClose} />;
    case 'layers': return <LayersPanelBody onClose={onClose} />;
    case 'sources': return <SourcesPanelBody onClose={onClose} />;
    case 'charts': return <ChartsPanelBody />;
    case 'flow': return <FlowPanelBody />;
    case 'document': return <DocumentPanelBody />;
    case 'cost': return <CostPanel onClose={onClose} />;
    case 'environment': return <EnvironmentPanel onClose={onClose} />;
    case 'drawing': return <DrawingPanelBody />;
    case 'pointclouds': return <PointCloudPanelBody onClose={onClose} />;
  }
}
