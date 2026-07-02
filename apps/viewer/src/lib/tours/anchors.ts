/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour anchor registry - the single source of truth for every `data-tour`
 * attribute in the viewer.
 *
 * Components spread `{...tourAnchor(TOUR_ANCHORS.xyz)}` on the target
 * element; tour step files reference the same constants. Renaming an anchor
 * is one edit here plus compile errors at every stale usage, which is what
 * keeps ten tours honest against a moving UI.
 *
 * AGENTS.md rule: if you move, rename, or delete an element carrying
 * `data-tour`, update this module and the referencing steps in
 * `lib/tours/tours/` in the same PR.
 */

import type { WorkspacePanelId } from '@/lib/panels/registry';

export const TOUR_ANCHORS = {
  /** The empty-state "Load IFC" card in ViewportContainer. */
  emptyStateCard: 'empty-state-card',
  /** PropertiesPanel root (valid docked, floating, or split). */
  propertiesPanel: 'properties-panel',
  /** HierarchyPanel root in the left slot. */
  hierarchyPanel: 'hierarchy-panel',
  /** ViewCube wrapper div (top-right viewport overlay). Card placement
   *  must stay clear of this corner - never anchor a card 'bottom' here. */
  viewcube: 'viewcube',
  /** SectionOverlay panel root. Exists while collapsed; the position
   *  slider itself only mounts once the panel is expanded, so anchor the
   *  root, not the slider. */
  sectionPanel: 'section-panel',
  /** IDSPanel empty-state "Load IDS File" button (only while no doc). */
  idsLoad: 'ids-load',
  /** IDSPanel "Run Validation" button (only while doc loaded, no report). */
  idsRun: 'ids-run',
  /** IDSPanel results summary header (only while a report exists). */
  idsSummary: 'ids-summary',
  /** IDSPanel specification-results scroll area (only while a report exists). */
  idsResults: 'ids-results',
  /** IDSPanel isolate-failed (EyeOff) toggle in the results actions bar. */
  idsIsolateFailed: 'ids-isolate-failed',
  /** ClashPanel "Detect all clashes" run button. */
  clashRun: 'clash-run',
  /** ClashPanel severity summary (only while a result exists). */
  clashSummary: 'clash-summary',
  /** ClashPanel results scroll container (always mounted with the panel). */
  clashResults: 'clash-results',
  /** ClashPanel "On select" focus-mode toggle group (result with clashes). */
  clashFocusMode: 'clash-focus-mode',
  /** ClashPanel "BCF topic" button in the results toolbar (result with clashes). */
  clashBcf: 'clash-bcf',
  /** ComparePanel A/B model-select grid (only with two loaded models). */
  compareAb: 'compare-ab',
  /** ComparePanel "Run comparison" button (only with two loaded models). */
  compareRun: 'compare-run',
  /** ComparePanel counts grid (only while a result exists). */
  compareCounts: 'compare-counts',
  /** CompareResultsList scroll area (two loaded models, not BCF-composing). */
  compareResults: 'compare-results',
  /** ChangeDetailView root (only while a MODIFIED row is selected). */
  compareDetail: 'compare-detail',
  /** LensPanel lens-list scroll container. */
  lensList: 'lens-list',
  /** LensCard legend. The auto-color and rule-based branches share this id;
   *  they are mutually exclusive and only the ACTIVE card mounts one. */
  lensLegend: 'lens-legend',
  /** LensPanel header Clear button (only while a lens is active). */
  lensClear: 'lens-clear',
  /** ScriptPanel CodeEditor wrapper. */
  scriptEditor: 'script-editor',
  /** ScriptPanel new-script (+) dropdown trigger. */
  scriptNew: 'script-new',
  /** ScriptPanel Run button. */
  scriptRun: 'script-run',
  /** ScriptPanel Output console container. */
  scriptOutput: 'script-output',
  /** ScriptPanel AI-chat toggle button. */
  scriptChatToggle: 'script-chat-toggle',
  /** BCFTopicList new-topic (+) button in the filter row (list view only). */
  bcfNewTopic: 'bcf-new-topic',
  /** BCFTopicDetail viewpoint Capture button (detail view only). */
  bcfCaptureViewpoint: 'bcf-capture-viewpoint',
  /** BCFPanel header Export BCF button (disabled until a topic exists). */
  bcfExport: 'bcf-export',
} as const;

/** Activity-bar rail button for a panel (one templated attribute serves
 *  every panel mini-tour). */
export function activityAnchor(id: WorkspacePanelId): `activity-${WorkspacePanelId}` {
  return `activity-${id}`;
}

/** MainToolbar tool button (one templated attribute serves every
 *  toolbar-tool mini-tour, e.g. measure, section). */
export function toolAnchor(tool: string): `tool-${string}` {
  return `tool-${tool}`;
}

/** LensPanel lens card by lens id (one templated attribute lets any tour
 *  target any card, e.g. the builtin 'lens-by-class'). */
export function lensCardAnchor(lensId: string): `lens-card-${string}` {
  return `lens-card-${lensId}`;
}

export type TourAnchorId =
  | (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS]
  | ReturnType<typeof activityAnchor>
  | ReturnType<typeof toolAnchor>
  | ReturnType<typeof lensCardAnchor>;

/** Spread helper: `<div {...tourAnchor(TOUR_ANCHORS.propertiesPanel)}>`. */
export function tourAnchor(id: TourAnchorId): { 'data-tour': TourAnchorId } {
  return { 'data-tour': id };
}

export function anchorSelector(id: TourAnchorId): string {
  return `[data-tour="${id}"]`;
}
