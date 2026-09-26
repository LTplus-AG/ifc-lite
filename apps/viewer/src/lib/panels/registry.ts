/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace-panel registry (issues #1200 / #1201 / #1208).
 *
 * Single source of truth for the panels the unified sidebar switches
 * between, floats, and pops out. Each entry carries its id, labels, icon,
 * an activity-bar `group` (for divider clustering) and a `prefersWide`
 * hint (code/table/timeline panels want a wider sidebar + bigger pop-out).
 *
 * The panel switcher, the activity bar, the keyboard shortcuts (Alt+N by
 * array index — DO NOT reorder the first seven, that mapping shipped in
 * #1200), the floating-panel host and the pop-out windows all read this.
 * The actual panel components are mapped from an id by `renderPanelBody`,
 * which keeps this module free of heavy imports.
 */

import { BarChart3, Box, CalendarRange, ClipboardCheck, Cloud, Coins, Crosshair, FileText, FileWarning, GitCompareArrows, Info, Layers as LayersIcon, ListTree, MessageSquare, Move3d, Palette, PencilRuler, Presentation, Puzzle, Ruler, Scan, Sun, Table2, Terminal, type LucideIcon, Users, Workflow } from 'lucide-react';

/** Every panel reachable from the unified sidebar rail. `properties` is the
 *  Properties panel (the right pane's default fallback). Each panel opens in
 *  its home {@link WorkspacePanelDef.region} — `side` panels in the right pane,
 *  `bottom` panels (Script / Schedule / Lists) in the bottom strip, and the
 *  `left` panel (Hierarchy) in the left navigation slot (#1267). */
export type WorkspacePanelId =
  | 'hierarchy'
  | 'properties'
  | 'compare'
  | 'bcf'
  | 'validation'
  | 'lens'
  | 'clash'
  | 'extensions'
  | 'sources'
  | 'script'
  | 'gantt'
  | 'lists'
  | 'collab'
  | 'layers'
  | 'zones'
  | 'loadReport'
  | 'appearance'
  | 'charts'
  | 'flow'
  | 'document'
  | 'cost'
  | 'environment'
  | 'drawing'
  | 'pointclouds'
  | 'measurements'
  | 'placement'
  | 'presentation';

/** Activity-bar clustering — a divider is drawn whenever the group changes. */
export type PanelGroup = 'navigate' | 'inspect' | 'review' | 'author' | 'work';

/** Where a panel docks when opened from the rail. `left` is the dedicated
 *  hierarchy navigation slot, toggled via `leftPanelCollapsed` (#1267). */
export type PanelRegion = 'side' | 'bottom' | 'left';

export interface WorkspacePanelDef {
  id: WorkspacePanelId;
  /** Full label (tooltip / floating-window title / sidebar header). */
  title: string;
  /** Short label for menus / the switcher dropdown. */
  short: string;
  Icon: LucideIcon;
  /** Activity-bar group used to cluster icons with dividers. */
  group: PanelGroup;
  /** Home dock: the right pane (`side`) or the bottom strip (`bottom`). */
  region: PanelRegion;
  /** Wider default pop-out / float size for content-heavy panels. */
  prefersWide?: boolean;
}

export const WORKSPACE_PANELS: readonly WorkspacePanelDef[] = [
  // Alt+1..9 / Alt+0 — order frozen since #1200 for the first seven.
  { id: 'properties', title: 'Properties', short: 'Props', Icon: Info, group: 'inspect', region: 'side' },
  { id: 'compare', title: 'Compare models', short: 'Compare', Icon: GitCompareArrows, group: 'inspect', region: 'side' },
  { id: 'bcf', title: 'BCF topics', short: 'BCF', Icon: MessageSquare, group: 'review', region: 'side' },
  // Renamed from 'ids' (#5138): the panel now covers both IDS validation and
  // rule-based information validation. Supersede = delete — `migratePanelId`
  // below is the only place the retired id is still spelled out.
  { id: 'validation', title: 'Data validation', short: 'Validation', Icon: ClipboardCheck, group: 'review', region: 'side' },
  { id: 'lens', title: 'Lens rules', short: 'Lens', Icon: Palette, group: 'review', region: 'side' },
  { id: 'clash', title: 'Clash detection', short: 'Clash', Icon: Crosshair, group: 'review', region: 'side' },
  { id: 'extensions', title: 'Extensions', short: 'Extensions', Icon: Puzzle, group: 'author', region: 'side' },
  // Bottom-strip panels — launched from the rail, open at the bottom by default.
  { id: 'script', title: 'Script editor', short: 'Script', Icon: Terminal, group: 'work', region: 'bottom', prefersWide: true },
  { id: 'gantt', title: 'Construction schedule', short: 'Schedule', Icon: CalendarRange, group: 'work', region: 'bottom', prefersWide: true },
  { id: 'lists', title: 'Entity lists', short: 'Lists', Icon: Table2, group: 'work', region: 'bottom', prefersWide: true },
  // Left-slot nav panel (#1267), APPENDED so the frozen Alt+1..0 mapping above
  // is untouched (it gets no Alt shortcut). Its default *display* position is the
  // top of the rail (see DEFAULT_ORDER in sidebarSlice); the activity bar toggles
  // its left slot via `leftPanelCollapsed` rather than the right-pane flags.
  { id: 'hierarchy', title: 'Hierarchy', short: 'Tree', Icon: ListTree, group: 'navigate', region: 'left' },
  // Collaboration room roster (link-based multiuser). APPENDED so the frozen
  // Alt+1..0 mapping stays intact (no Alt shortcut). The activity bar hides it
  // while the collab feature flag is off (see ActivityBar).
  { id: 'collab', title: 'Collaboration room', short: 'Room', Icon: Users, group: 'review', region: 'side' },
  // Cloud sources (CDE integrations). APPENDED — no Alt shortcut. Always on
  // the rail; providers that failed to register are reported inside the panel.
  { id: 'sources', title: 'Cloud sources', short: 'Sources', Icon: Cloud, group: 'inspect', region: 'side' },
  // IFCX layer stack + per-layer diff (#1717). APPENDED so the frozen
  // Alt+1..0 mapping stays intact (no Alt shortcut). The activity bar only
  // surfaces it while a federated layer stack is loaded.
  { id: 'layers', title: 'Layer stack', short: 'Layers', Icon: LayersIcon, group: 'review', region: 'side' },
  // Location zones (construction sections / takt areas, #1810). APPENDED so
  // the frozen Alt+1..0 mapping stays intact (no Alt shortcut).
  { id: 'zones', title: 'Location zones', short: 'Zones', Icon: Box, group: 'review', region: 'side' },
  // Flag-free like 'zones' above (#1869 precedent) — no dedicated
  // `loadReportPanelVisible` boolean; `openWorkspacePanel`'s generic
  // non-SIDEBAR_PANEL_FLAGS branch adopts it directly (issue #3927).
  { id: 'loadReport', title: 'Load report', short: 'Load report', Icon: FileWarning, group: 'review', region: 'side' },
  { id: 'appearance', title: 'Appearance', short: 'Appearance', Icon: Palette, group: 'author', region: 'side' },
  // Charts bound to the model, bidirectional with the 3D view (#3944). Bottom
  // strip like Lists / Schedule; the table in `bottom-panels.ts` carries it.
  { id: 'charts', title: 'Charts', short: 'Charts', Icon: BarChart3, group: 'work', region: 'bottom', prefersWide: true },
  // Node-graph editor over the SDK (#5167): the same `*.flow.json` the CLI runs. Bottom strip, table-driven like Charts.
  { id: 'flow', title: 'Flow', short: 'Flow', Icon: Workflow, group: 'author', region: 'bottom', prefersWide: true },
  // A free-form page over the model — text with bindings, logos, charts, BCF topics — printed to PDF (#4594).
  { id: 'document', title: 'Document', short: 'Document', Icon: FileText, group: 'work', region: 'bottom', prefersWide: true },
  // Read-only IFC 5D cost inspector: schedule/item tree + detail (#4858). APPENDED
  // so the frozen Alt+1..0 mapping stays intact (no Alt shortcut). Flag-free
  // like 'zones'/'loadReport' above (#1869 precedent) — docks in the right
  // pane, no dedicated costPanelVisible boolean or bottom-strip wiring.
  { id: 'cost', title: 'Cost', short: 'Cost', Icon: Coins, group: 'inspect', region: 'side', prefersWide: true },
  // Environment — sky, lighting presets and the sun-path study (#5506: the
  // docked side panel that replaced the floating "Sun & Sky" panel).
  // APPENDED so the frozen Alt+1..0 mapping stays intact (no Alt shortcut).
  // Flag-free like 'zones'/'loadReport'/'cost' above (#1869 precedent) —
  // docks in the right pane, no dedicated envPanelOpen visibility flag.
  { id: 'environment', title: 'Environment', short: 'Environment', Icon: Sun, group: 'author', region: 'side' },
  // The 2D drawing of the current section (#5493): docks in the bottom strip
  // instead of floating over the 3D view, so it can float or pop out like any
  // other panel. APPENDED (no Alt shortcut); its runtime is DrawingRuntimeHost.
  { id: 'drawing', title: 'Drawing', short: '2D', Icon: PencilRuler, group: 'work', region: 'bottom', prefersWide: true },
  // Point cloud rendering controls + BIM<->scan deviation heatmap (#5507).
  // Replaces the floating `PointCloudPanel` card that used to sit at
  // `bottom-4 left-4`, colliding with the axis/scale cluster there. Flag-free
  // like 'zones'/'loadReport'/'cost' above (#1869 precedent) — driven purely
  // by `sidebarActivePanel`, no dedicated visibility boolean. APPENDED so the
  // frozen Alt+1..0 mapping stays intact (no Alt shortcut). The activity bar
  // only shows its rail icon while `pointCloudAssetCount > 0`, the same way
  // it hides the Room icon while collab is disabled.
  { id: 'pointclouds', title: 'Point Clouds', short: 'Point Clouds', Icon: Scan, group: 'inspect', region: 'side' },
  // The Measure tool's LIST / POINT / QTY readouts (#5502): they used to expand
  // out of a floating card over the model; the tool's bar now lives on the
  // HUD and opens this docked panel instead. Flag-free like 'environment' /
  // 'pointclouds' (#1869 precedent). APPENDED so the frozen Alt+1..0 mapping
  // stays intact (no Alt shortcut).
  { id: 'measurements', title: 'Measurements', short: 'Measure', Icon: Ruler, group: 'inspect', region: 'side' },
  // Local reposition + georeference editing (#5505): replaces the floating
  // `RepositionPanel` (`absolute top-32 right-4`) and the floating
  // `CesiumPlacementEditor` card with one docked panel, Local / Georeference
  // tabs. Flag-free like 'zones'/'loadReport'/'cost'/'pointclouds' above
  // (#1869 precedent) — driven by `repositionOpen` / `cesiumPlacementEditMode`,
  // no dedicated visibility boolean. APPENDED so the frozen Alt+1..0 mapping
  // stays intact (no Alt shortcut). The gizmos stay scene overlays.
  { id: 'placement', title: 'Placement', short: 'Placement', Icon: Move3d, group: 'author', region: 'side' },
  // A filmstrip of saved basket views (#5508). Replaces `BasketPresentationDock`,
  // which drew an always-on "Presentation 0" pill at the viewport's
  // bottom-center even with an empty basket, and opened as its own
  // draggable / resizable floating card. Bottom strip like Charts/Document/
  // Flow/Drawing above — table-driven; the bottom-strip flag it reuses is
  // `basketPresentationVisible` (`lib/panels/bottom-panels.ts`), unchanged
  // from the floating dock so saved views and their transitions are
  // unaffected. APPENDED so the frozen Alt+1..0 mapping stays intact (no Alt
  // shortcut). Entry points: the status bar and the ribbon / classic
  // toolbar's Present button.
  { id: 'presentation', title: 'Presentation', short: 'Present', Icon: Presentation, group: 'work', region: 'bottom', prefersWide: true },
];

// The bottom strip (Script / Schedule / Lists) is table-driven; the id union and
// the type guard are re-exported here so registry consumers keep one import.
export { isBottomPanel, type BottomPanelId } from './bottom-panels';

/** The left-slot nav panel (Hierarchy, #1267): toggled via `leftPanelCollapsed`,
 *  never floated / popped / docked into the right pane. */
export function isLeftPanel(id: WorkspacePanelId): id is 'hierarchy' {
  return id === 'hierarchy';
}

const PANEL_BY_ID = new Map<WorkspacePanelId, WorkspacePanelDef>(WORKSPACE_PANELS.map((p) => [p.id, p]));

export function getPanelDef(id: WorkspacePanelId): WorkspacePanelDef | undefined {
  return PANEL_BY_ID.get(id);
}

/** Type guard for narrowing arbitrary strings to a known panel id. */
export function isWorkspacePanelId(id: string): id is WorkspacePanelId {
  return PANEL_BY_ID.has(id as WorkspacePanelId);
}

/** Panel ids retired by a rename, mapped to their replacement (#5138: the
 *  IDS panel became the Data validation panel, `'ids'` -> `'validation'`). */
const LEGACY_PANEL_ID_MIGRATIONS: Readonly<Record<string, WorkspacePanelId>> = {
  ids: 'validation',
};

/**
 * Resolve a persisted panel id (sidebar order/hidden set, dock/float layout)
 * to a live {@link WorkspacePanelId}, migrating a retired id to its
 * replacement instead of silently dropping it. `undefined` means the id is
 * neither current nor a known legacy alias — genuinely unrecognised, and the
 * caller's existing "drop it" handling applies.
 */
export function migratePanelId(id: string): WorkspacePanelId | undefined {
  if (isWorkspacePanelId(id)) return id;
  return LEGACY_PANEL_ID_MIGRATIONS[id];
}

/** The panels Alt+1..9 / Alt+0 open, in key order (Alt+0 is the tenth). */
export const ALT_SHORTCUT_PANELS: readonly WorkspacePanelDef[] = WORKSPACE_PANELS.slice(0, 10);

/**
 * Map an Alt+digit shortcut's `KeyboardEvent.code` to the workspace panel it
 * opens (#1200/#1208). Digit/Numpad 1-9 select the first nine panels; 0 selects
 * the tenth. Keyed off `code` (not `key`) so it stays layout-independent — on
 * macOS Alt+1 yields the character "¡" but the code is still "Digit1". Returns
 * undefined for non-digit codes (so other Alt combos fall through) or a digit
 * past the registry length.
 */
export function workspacePanelForShortcutCode(code: string): WorkspacePanelId | undefined {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!m) return undefined;
  const n = Number(m[1]);
  return ALT_SHORTCUT_PANELS[n === 0 ? 9 : n - 1]?.id;
}

/** The analysis / tool panels that toggle in the sidebar (everything except
 *  the Properties fallback, which shows when no other panel is open). */
export type AnalysisPanelId = Exclude<WorkspacePanelId, 'properties'>;

export function isAnalysisPanel(id: WorkspacePanelId): id is AnalysisPanelId {
  return id !== 'properties';
}

/** Default docked-sidebar width as a % of the viewport, and the wider default
 *  used when a `prefersWide` panel (Script / Gantt / Lists) is active. */
export const SIDEBAR_DEFAULT_WIDTH_PCT = 22;
export const SIDEBAR_WIDE_WIDTH_PCT = 40;
