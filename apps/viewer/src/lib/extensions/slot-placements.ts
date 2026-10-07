/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which extension slots this viewer actually renders (#6927, U04), and why a
 * placement is unavailable when it does not. The slot registry accepts any
 * slot id, so without this map a contribution to an unrendered slot vanished
 * without a trace. The Extensions panel lists every unavailable placement
 * with its reason instead.
 *
 * AI program surfaces are mapped here too. Their renderers are host-owned
 * native components (docs/architecture/ai-customization/03-ui-surface.md
 * section 1: the sandbox describes UI, the host renders it), so an extension
 * contributes commands, which the palette and context menus already render,
 * never a proposal renderer or review/result chrome of its own.
 */

import type { SlotContribution } from '@ifc-lite/extensions';

export type PlacementReason =
  /** Part of the slot catalogue, but no viewer surface renders it yet. */
  | 'not-rendered'
  /** A host-owned AI/review surface; extensions contribute commands instead. */
  | 'host-owned'
  /** A slot id this viewer does not know (newer manifest, typo, other host). */
  | 'unknown-slot';

export type SlotPlacement =
  | { status: 'rendered' }
  | { status: 'unavailable'; reason: PlacementReason };

const RENDERED: SlotPlacement = { status: 'rendered' };
const NOT_RENDERED: SlotPlacement = { status: 'unavailable', reason: 'not-rendered' };
const HOST_OWNED: SlotPlacement = { status: 'unavailable', reason: 'host-owned' };

/** Every slot id the viewer has an answer for. Keep in step with the mounts. */
export const SLOT_PLACEMENTS: Readonly<Record<string, SlotPlacement>> = {
  // CommandPalette.tsx, ExtensionKeyboardBindings.tsx, useExtensionExporters.ts
  commandPalette: RENDERED,
  keybindings: RENDERED,
  exportMenu: RENDERED,
  // RibbonToolbar.tsx; ViewerLayout.tsx and SidebarPanelHost.tsx docks
  'toolbar.right': RENDERED,
  'dock.left': RENDERED,
  'dock.right': RENDERED,
  'dock.bottom': RENDERED,
  // EntityContextMenuItems.tsx
  'contextMenu.entity': RENDERED,
  'contextMenu.canvas': RENDERED,
  // Read from the manifest by host-flows.ts, not through the registry.
  flowLibrary: NOT_RENDERED,
  'toolbar.left': NOT_RENDERED,
  'toolbar.center': NOT_RENDERED,
  'contextMenu.tree': NOT_RENDERED,
  'statusBar.left': NOT_RENDERED,
  'statusBar.right': NOT_RENDERED,
  lensLibrary: NOT_RENDERED,
  'idsRules.custom': NOT_RENDERED,
  // AI program surfaces: native renderers only.
  'assistant.proposal': HOST_OWNED,
  'assistant.evidence': HOST_OWNED,
  'review.actions': HOST_OWNED,
  'resultView.actions': HOST_OWNED,
};

export function slotPlacement(slot: string): SlotPlacement {
  return Object.prototype.hasOwnProperty.call(SLOT_PLACEMENTS, slot) ? SLOT_PLACEMENTS[slot] : { status: 'unavailable', reason: 'unknown-slot' };
}

export interface UnavailablePlacement {
  extensionId: string;
  slot: string;
  /** The contribution's own id or command, for the user to recognise it. */
  label: string;
  reason: PlacementReason;
}

function contributionLabel(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as Record<string, unknown>;
  for (const key of ['title', 'text', 'id', 'command']) {
    if (typeof value[key] === 'string' && value[key]) return (value[key] as string).slice(0, 120);
  }
  return '';
}

/** Every registered contribution that no surface will show, with its reason. */
export function unavailablePlacements(registry: {
  listSlots(): string[];
  getAll(slot: string): SlotContribution[];
}): UnavailablePlacement[] {
  const out: UnavailablePlacement[] = [];
  for (const slot of [...registry.listSlots()].sort()) {
    const placement = slotPlacement(slot);
    if (placement.status === 'rendered') continue;
    for (const contribution of registry.getAll(slot)) {
      out.push({ extensionId: contribution.extensionId, slot, label: contributionLabel(contribution.payload), reason: placement.reason });
    }
  }
  return out;
}
