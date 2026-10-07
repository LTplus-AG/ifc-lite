/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storage around the versioned sidebar layout (#6927). The layout key keeps
 * its historical name so older builds still read it. A migration that changes
 * anything first copies the ORIGINAL value to a backup key (never deleted by
 * this module) and queues the changes for the review notice, which survives a
 * reload until the user keeps or resets the layout.
 */

import { migrateSidebarLayout, readLayoutChanges, layoutChangeKey, type LayoutChange, type StoredSidebarLayout } from './layout-migration';

export const SIDEBAR_LAYOUT_KEY = 'ifc-lite:sidebar-layout-v1';
export const LAYOUT_BACKUP_KEY = 'ifc-lite:sidebar-layout-backup-v1';
export const LAYOUT_NOTICE_KEY = 'ifc-lite:layout-migration-notice-v1';

export interface LayoutBackup {
  reason: 'migration';
  savedAt: string;
  /** The exact stored string before migration. */
  raw: string;
}

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function writeSidebarLayout(layout: StoredSidebarLayout): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(layout));
  } catch (error) {
    // Quota / private mode: the layout just won't persist this session.
    console.warn('[sidebar] failed to persist layout:', error);
  }
}

export function readPendingLayoutChanges(): LayoutChange[] {
  const raw = storage()?.getItem(LAYOUT_NOTICE_KEY);
  if (!raw) return [];
  try {
    return readLayoutChanges((JSON.parse(raw) as { changes?: unknown }).changes);
  } catch (error) {
    console.warn('[sidebar] ignoring unreadable layout notice:', error);
    return [];
  }
}

/** Merge new changes into the pending notice (a later `added` replaces none). */
export function queueLayoutChanges(changes: readonly LayoutChange[]): LayoutChange[] {
  const merged = new Map(readPendingLayoutChanges().map((change) => [layoutChangeKey(change), change]));
  for (const change of changes) merged.set(layoutChangeKey(change), change);
  const list = [...merged.values()];
  try {
    storage()?.setItem(LAYOUT_NOTICE_KEY, JSON.stringify({ changes: list }));
  } catch (error) {
    console.warn('[sidebar] failed to persist the layout notice:', error);
  }
  return list;
}

export function clearLayoutNotice(): void {
  try {
    storage()?.removeItem(LAYOUT_NOTICE_KEY);
  } catch (error) {
    console.warn('[sidebar] failed to clear the layout notice:', error);
  }
}

export function readLayoutBackup(): LayoutBackup | null {
  const raw = storage()?.getItem(LAYOUT_BACKUP_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LayoutBackup>;
    return value.reason === 'migration' && typeof value.raw === 'string' && typeof value.savedAt === 'string'
      ? { reason: 'migration', savedAt: value.savedAt, raw: value.raw } : null;
  } catch (error) {
    console.warn('[sidebar] unreadable layout backup:', error);
    return null;
  }
}

function backupOriginal(raw: string): void {
  // The first original of a pending review is the one worth keeping.
  if (readPendingLayoutChanges().length > 0 && readLayoutBackup()) return;
  try {
    storage()?.setItem(LAYOUT_BACKUP_KEY, JSON.stringify({ reason: 'migration', savedAt: new Date().toISOString(), raw } satisfies LayoutBackup));
  } catch (error) {
    console.warn('[sidebar] failed to back up the layout before migration:', error);
  }
}

/** Boot read: migrate, back up the original if anything changed, stamp v2. */
export function loadSidebarLayout(): { layout: StoredSidebarLayout; pending: LayoutChange[] } {
  const store = storage();
  const raw = store?.getItem(SIDEBAR_LAYOUT_KEY) ?? null;
  if (raw === null) return { layout: migrateSidebarLayout(null).layout, pending: readPendingLayoutChanges() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[sidebar] keeping a backup of an unreadable layout:', error);
    parsed = '';
  }
  const migration = migrateSidebarLayout(parsed);
  if (migration.changes.length > 0) {
    backupOriginal(raw);
    writeSidebarLayout(migration.layout);
    return { layout: migration.layout, pending: queueLayoutChanges(migration.changes) };
  }
  if (migration.fromVersion === 1) writeSidebarLayout(migration.layout);
  return { layout: migration.layout, pending: readPendingLayoutChanges() };
}
