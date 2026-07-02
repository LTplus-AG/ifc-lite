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

export type TourAnchorId =
  | (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS]
  | ReturnType<typeof activityAnchor>
  | ReturnType<typeof toolAnchor>;

/** Spread helper: `<div {...tourAnchor(TOUR_ANCHORS.propertiesPanel)}>`. */
export function tourAnchor(id: TourAnchorId): { 'data-tour': TourAnchorId } {
  return { 'data-tour': id };
}

export function anchorSelector(id: TourAnchorId): string {
  return `[data-tour="${id}"]`;
}
