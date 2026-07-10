/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Interactive walkthrough (tour) core types.
 *
 * Tours are task-gated: an `action` step completes when the viewer store
 * proves the user actually did the thing (a predicate flips false to true,
 * or a window event fires), never on a timer. Every step is individually
 * skippable, so a tour can never trap the user.
 */

import type { ViewerState, EntityRef, CameraViewpoint, SectionPlaneAxis } from '@/store';
import type { SidebarMode } from '@/store';
import type { WorkspacePanelId, BottomPanelId } from '@/lib/panels/registry';
import type { TourAnchorId } from './anchors';

/** The zustand store api (getState / setState / subscribe + hook). */
export type ViewerStoreApi = typeof import('@/store').useViewerStore;

export type TourId = string;

export type TourStepKind =
  | 'passive' // spotlight + Next button
  | 'action'  // spotlight + task gate; advances when the real thing happens
  | 'canvas'; // edge-docked card over the 3D viewport, no dim

/** Per-step scratch space, created fresh each time a step activates. */
export interface TourStepContext {
  /** Counters captured by `arm()` at step entry (e.g. measurement count). */
  baseline: Record<string, number>;
  /** Tour-created artifacts recorded for `cleanup()` (never user data). */
  artifacts: Map<string, unknown>;
}

export interface TourStepGate {
  /**
   * Cheap, pure field-read over the viewer store. The step completes on the
   * false-to-true edge; a gate already true at step entry completes the step
   * silently (no flash of an already-satisfied instruction).
   */
  predicate?: (state: ViewerState, ctx: TourStepContext) => boolean;
  /** Window CustomEvent name that also completes the step (either wins). */
  event?: string;
  /** Only complete on events whose `detail.kind` matches (e.g. a ViewCube
   *  'preset' on the shared camera-interacted event). */
  eventKind?: string;
  /** Emphasize Skip and show a hint after this long. Default 15000. */
  hintAfterMs?: number;
}

export interface TourStepAction {
  /** Small secondary button on the step card (e.g. "Load demo project"). */
  label: string;
  run: (store: ViewerStoreApi) => void | Promise<void>;
}

export interface TourStep {
  id: string;
  kind: TourStepKind;
  /** Anchor target; required for passive/action, absent for canvas steps. */
  anchor?: TourAnchorId;
  /** floating-ui placement hint. Default 'bottom' (with flip/shift). */
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Panel that must be docked and open for the anchor to exist. The engine
   * routes through `showWorkspacePanel` before resolving, which also re-docks
   * a floating / popped-out panel (a main-document overlay cannot reach
   * another OS window).
   */
  panel?: WorkspacePanelId;
  title: string;
  body: string;
  /** Idempotent pre-step setup (open a panel, set a tool). */
  prepare?: (store: ViewerStoreApi) => void | Promise<void>;
  /** Capture baseline counters at step entry. */
  arm?: (state: ViewerState, ctx: TourStepContext) => void;
  /** Absent = passive step (Next button). */
  gate?: TourStepGate;
  /** Optional card button, e.g. the demo-load fallback. */
  action?: TourStepAction;
  /**
   * Remove artifacts THIS step created (never the user's work). Runs in
   * reverse order on finish and abort. Must be idempotent.
   */
  cleanup?: (store: ViewerStoreApi, ctx: TourStepContext) => void;
  /**
   * This step legitimately triggers or waits for a model load (file open,
   * demo load). Suppresses the destructive-signal abort for loads that start
   * while the step is active.
   */
  expectsModelLoad?: boolean;
}

export interface TourPrerequisites {
  /** models.size > 0 && !loading && !geometryStreamingActive */
  modelLoaded?: boolean;
  /** At least two fully loaded models (compare tour). */
  secondModel?: boolean;
}

/** Snapshot fields a tour may keep applied after a successful finish. */
export type UiSnapshotKey = keyof UiSnapshot;

export interface TourDefinition {
  id: TourId;
  title: string;
  description: string;
  /** Rough duration shown in the Learn hub. */
  minutes: number;
  /**
   * Bump when the tour content changes enough that completed users should
   * see its entry points again.
   */
  version: number;
  /** Panel this tour teaches; lights up that panel's header help button. */
  panel?: WorkspacePanelId;
  prerequisites?: TourPrerequisites;
  /**
   * How "Load demo project" on the prerequisite interstitial fulfils THIS
   * tour's needs (e.g. compare loads base + rev B). Defaults to loading the
   * base demo model.
   */
  demoFulfil?: () => Promise<void>;
  /**
   * Snapshot fields NOT restored on finish, so the tour's visible outcome
   * survives (abort always restores everything). Example: the lens tour
   * keeps `activeLensId` applied.
   */
  keepOnFinish?: UiSnapshotKey[];
  steps: TourStep[];
}

/** How a tour was started; recorded in telemetry. */
export type TourSource = 'invite' | 'learn' | 'palette' | 'panel';

export type TourAbortReason =
  | 'close'        // X on the card
  | 'mobile-flip'  // viewport became mobile; the desktop layout unmounted
  | 'model-change' // a model the tour was running against was removed/replaced
  | 'error';

export type TourBrokenReason =
  | 'anchor-missing'
  | 'panel-unavailable'
  | 'panel-hidden-by-user'
  | 'prerequisite-not-met'
  | 'predicate-error';

/**
 * Cheap UI-only state captured at tour start and restored on finish/abort.
 * Deliberately excludes cross-file workspace prefs the tour must not own
 * (sidebar order/hidden set, float layout, section cap style) and all data.
 */
export interface UiSnapshot {
  sidebarMode: SidebarMode;
  /** Which side panel owned the docked slot (null = Information fallback). */
  openSidePanel: WorkspacePanelId | null;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomPanel: BottomPanelId | null;
  activeTool: string;
  editEnabled: boolean;
  propertiesActiveTab: ViewerState['propertiesActiveTab'];
  selection: {
    selectedEntityId: number | null;
    selectedEntityIds: number[];
    selectedEntity: EntityRef | null;
    selectedEntitiesSet: string[];
    selectedEntities: EntityRef[];
    selectedModelId: string | null;
  };
  activeStorey: EntityRef | null;
  selectedStoreys: number[];
  sectionPlane: {
    axis: SectionPlaneAxis;
    position: number;
    enabled: boolean;
    flipped: boolean;
    /** Face-picked plane params; captured so an abort can restore a
     *  pre-tour custom cut, not just the cardinal fields. */
    custom: ViewerState['sectionPlane']['custom'];
  };
  activeLensId: string | null;
  /** May be null before the renderer registered camera callbacks. */
  camera: CameraViewpoint | null;
  /** Restore of camera/selection is skipped when this set changed mid-run. */
  modelIdsAtStart: string[];
}

export type TourStatus = 'idle' | 'prereq' | 'running';

export type TourStepPhase = 'preparing' | 'anchoring' | 'active';
