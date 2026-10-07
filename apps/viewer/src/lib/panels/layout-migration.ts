/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Versioned migration of the persisted sidebar layout (#6927, U04).
 *
 * Version 1 is the unversioned `ifc-lite:sidebar-layout-v1` value written
 * since #1208: `{ mode, widthPct, order, hiddenIds }`. Version 2 adds a
 * `version` field and `preserved` placements. A v1 build can read the four
 * common fields, but its next save drops v2 metadata. Unknown placements
 * survive saves only in builds that implement preservation; the backup
 * remains a recovery source when returning from an older writer.
 *
 * Rules, each reported as a {@link LayoutChange} so the user can preview what
 * moved and reset if they disagree:
 * - a retired panel id migrates to its replacement (`ids` -> `validation`);
 * - a panel shipped after the layout was saved (e.g. `assistant`) is inserted
 *   after the user's last panel of the same task group, not at the bottom;
 * - an id this build does not know (a newer build's panel, an extension's)
 *   is PRESERVED with its anchor instead of dropped, and restored in place
 *   once a build that knows it reads the layout again;
 * - an untouched pre-#5873 default order is regrouped; a custom order is kept.
 */

import { WORKSPACE_PANELS, PANEL_GROUPS, SIDEBAR_DEFAULT_WIDTH_PCT, getPanelDef, isWorkspacePanelId, migratePanelId, type WorkspacePanelId } from './registry';

export type SidebarMode = 'expanded' | 'collapsed';

/** The portable shape captured into a Flavor's `layout.state.sidebar`. */
export interface SidebarLayoutSnapshot {
  mode: SidebarMode;
  widthPct: number;
  order: WorkspacePanelId[];
  hiddenIds: WorkspacePanelId[];
}

/** A rail placement this build cannot show, kept so it is not lost. */
export interface PreservedPlacement {
  id: string;
  /** The id it followed in the saved order; null for the top. */
  after: string | null;
  hidden: boolean;
}

export const SIDEBAR_LAYOUT_VERSION = 2;

export interface StoredSidebarLayout extends SidebarLayoutSnapshot {
  version: typeof SIDEBAR_LAYOUT_VERSION;
  preserved: PreservedPlacement[];
}

export type LayoutChange =
  | { kind: 'renamed'; from: string; to: WorkspacePanelId }
  | { kind: 'added'; id: WorkspacePanelId; after: WorkspacePanelId | null }
  | { kind: 'restored'; id: WorkspacePanelId }
  | { kind: 'preserved'; id: string }
  | { kind: 'regrouped' }
  | { kind: 'mode'; from: string; to: SidebarMode }
  | { kind: 'unreadable' };

export interface SidebarMigration {
  layout: StoredSidebarLayout;
  /** 1 or 2 for a saved layout; null when nothing was saved. */
  fromVersion: 1 | 2 | null;
  changes: LayoutChange[];
}

const MIN_WIDTH_PCT = 14;
const MAX_WIDTH_PCT = 60;
const MAX_PRESERVED = 64;

// Fresh layouts cluster the registry's task groups. Hierarchy leads Coordinate
// without changing the registry's frozen Alt+digit order (#1200, #5873).
export const DEFAULT_SIDEBAR_ORDER: readonly WorkspacePanelId[] = PANEL_GROUPS.flatMap((group) => {
  const ids = WORKSPACE_PANELS.filter((panel) => panel.group === group.id).map((panel) => panel.id);
  return group.id === 'coordinate'
    ? [...ids.filter((id) => id === 'hierarchy'), ...ids.filter((id) => id !== 'hierarchy')]
    : ids;
});

// An unchanged saved order from before task groups receives the grouping.
const PRE_GROUP_DEFAULT_ORDER: readonly WorkspacePanelId[] = [
  'hierarchy',
  ...WORKSPACE_PANELS.map((panel) => panel.id).filter((id) => id !== 'hierarchy'),
];

export function defaultSidebarLayout(): StoredSidebarLayout {
  return { version: SIDEBAR_LAYOUT_VERSION, mode: 'expanded', widthPct: SIDEBAR_DEFAULT_WIDTH_PCT,
    order: [...DEFAULT_SIDEBAR_ORDER], hiddenIds: [], preserved: [] };
}

export function clampSidebarWidth(pct: number): number {
  if (!Number.isFinite(pct)) return SIDEBAR_DEFAULT_WIDTH_PCT;
  return Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, pct));
}

function readPreserved(value: unknown): PreservedPlacement[] {
  if (!Array.isArray(value)) return [];
  const out: PreservedPlacement[] = [];
  for (const raw of value.slice(0, MAX_PRESERVED)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 200) continue;
    const after = typeof item.after === 'string' ? item.after : null;
    out.push({ id: item.id, after, hidden: item.hidden === true });
  }
  return out;
}

function insertAfter(order: WorkspacePanelId[], id: WorkspacePanelId, after: string | null): WorkspacePanelId | null {
  if (after === null) { order.unshift(id); return null; }
  const index = order.indexOf(after as WorkspacePanelId);
  if (index === -1) { order.push(id); return order[order.length - 2] ?? null; }
  order.splice(index + 1, 0, id);
  return order[index];
}

/** Where a newly shipped panel lands: after the last panel of its group. */
function anchorForNewPanel(order: readonly WorkspacePanelId[], id: WorkspacePanelId): string | null {
  if (id === 'hierarchy') return null;
  const group = getPanelDef(id)?.group;
  for (let i = order.length - 1; i >= 0; i--) {
    if (getPanelDef(order[i])?.group === group) return order[i];
  }
  return order[order.length - 1] ?? null;
}

/**
 * Reconcile any saved/captured sidebar value with the live registry. Pure:
 * reads nothing but its argument, so a profile preview and the boot loader
 * explain exactly the same changes.
 */
export function migrateSidebarLayout(raw: unknown, fallbackMode: SidebarMode = 'expanded'): SidebarMigration {
  if (raw === null || raw === undefined) return { layout: defaultSidebarLayout(), fromVersion: null, changes: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { layout: defaultSidebarLayout(), fromVersion: 1, changes: [{ kind: 'unreadable' }] };
  }
  const value = raw as Record<string, unknown>;
  const fromVersion = value.version === SIDEBAR_LAYOUT_VERSION ? 2 : 1;
  const changes: LayoutChange[] = [];
  const order: WorkspacePanelId[] = [];
  const seen = new Set<string>();
  const preserved: PreservedPlacement[] = [];
  const hiddenRaw = Array.isArray(value.hiddenIds) ? value.hiddenIds.filter((id): id is string => typeof id === 'string') : [];
  const hiddenSet = new Set(hiddenRaw);
  let previous: string | null = null;
  for (const id of Array.isArray(value.order) ? value.order : []) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const live = migratePanelId(id);
    if (live === undefined) {
      preserved.push({ id, after: previous, hidden: hiddenSet.has(id) });
      changes.push({ kind: 'preserved', id });
    } else if (!order.includes(live)) {
      if (live !== id) changes.push({ kind: 'renamed', from: id, to: live });
      order.push(live);
    }
    previous = id;
  }
  // An id hidden but absent from the order keeps its hidden flag too.
  for (const id of hiddenRaw) {
    if (!seen.has(id) && migratePanelId(id) === undefined && !preserved.some((p) => p.id === id)) {
      preserved.push({ id, after: null, hidden: true });
      changes.push({ kind: 'preserved', id });
    }
  }
  if (order.length >= 10) {
    const priorOrder = PRE_GROUP_DEFAULT_ORDER.filter((id) => order.includes(id));
    if (order.length === priorOrder.length && order.every((id, index) => id === priorOrder[index])) {
      order.splice(0, order.length, ...DEFAULT_SIDEBAR_ORDER.filter((id) => order.includes(id)));
      changes.push({ kind: 'regrouped' });
    }
  }
  const restoredHidden: WorkspacePanelId[] = [];
  const restoredPlacements: Array<{ id: WorkspacePanelId; after: string | null }> = [];
  for (const placement of readPreserved(value.preserved)) {
    const live = migratePanelId(placement.id);
    if (live === undefined) {
      if (!preserved.some((p) => p.id === placement.id)) preserved.push(placement);
      continue;
    }
    if (order.includes(live)) continue;
    const anchor = placement.after === null ? null : migratePanelId(placement.after) ?? placement.after;
    insertAfter(order, live, anchor);
    restoredPlacements.push({ id: live, after: anchor });
    if (placement.hidden) restoredHidden.push(live);
    changes.push({ kind: 'restored', id: live });
  }
  for (const id of DEFAULT_SIDEBAR_ORDER) {
    if (order.includes(id)) continue;
    const after = insertAfter(order, id, anchorForNewPanel(order, id));
    changes.push({ kind: 'added', id, after: after as WorkspacePanelId | null });
  }
  // Explicit saved anchors take precedence over newly inserted task-group neighbours.
  for (const placement of restoredPlacements) {
    order.splice(order.indexOf(placement.id), 1);
    insertAfter(order, placement.id, placement.after);
  }
  const hiddenIds = new Set<WorkspacePanelId>(restoredHidden);
  for (const id of hiddenRaw) {
    const live = migratePanelId(id);
    if (live !== undefined && live !== 'properties') hiddenIds.add(live);
  }
  let mode: SidebarMode = fallbackMode;
  if (value.mode === 'expanded' || value.mode === 'collapsed') mode = value.mode;
  else if (value.mode === 'hidden') { mode = 'collapsed'; changes.push({ kind: 'mode', from: 'hidden', to: 'collapsed' }); }
  const widthPct = clampSidebarWidth(typeof value.widthPct === 'number' ? value.widthPct : SIDEBAR_DEFAULT_WIDTH_PCT);
  return {
    layout: { version: SIDEBAR_LAYOUT_VERSION, mode, widthPct, order, hiddenIds: [...hiddenIds], preserved },
    fromVersion,
    changes,
  };
}

/** Changes a user should be told about (a v1 -> v2 stamp alone is silent). */
export function layoutChangesNeedReview(changes: readonly LayoutChange[]): boolean {
  return changes.length > 0;
}

/** Stable key for a change, for lists and de-duplication. */
export function layoutChangeKey(change: LayoutChange): string {
  switch (change.kind) {
    case 'renamed': return `renamed:${change.from}`;
    case 'added': case 'restored': case 'preserved': return `${change.kind}:${change.id}`;
    case 'mode': return 'mode';
    case 'regrouped': case 'unreadable': return change.kind;
  }
}

/** Accept only well-formed, de-duplicated change records (from storage). */
export function readLayoutChanges(value: unknown): LayoutChange[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, LayoutChange>();
  for (const raw of value.slice(0, 128)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    let change: LayoutChange | null = null;
    if (c.kind === 'renamed' && typeof c.from === 'string' && typeof c.to === 'string' && isWorkspacePanelId(c.to)) change = { kind: 'renamed', from: c.from, to: c.to };
    else if ((c.kind === 'added') && typeof c.id === 'string' && isWorkspacePanelId(c.id)) {
      const after = typeof c.after === 'string' && isWorkspacePanelId(c.after) ? c.after : null;
      change = { kind: 'added', id: c.id, after };
    } else if (c.kind === 'restored' && typeof c.id === 'string' && isWorkspacePanelId(c.id)) change = { kind: 'restored', id: c.id };
    else if (c.kind === 'preserved' && typeof c.id === 'string') change = { kind: 'preserved', id: c.id };
    else if (c.kind === 'mode' && typeof c.from === 'string' && (c.to === 'expanded' || c.to === 'collapsed')) change = { kind: 'mode', from: c.from, to: c.to };
    else if (c.kind === 'regrouped' || c.kind === 'unreadable') change = { kind: c.kind };
    if (change) out.set(layoutChangeKey(change), change);
  }
  return [...out.values()];
}
