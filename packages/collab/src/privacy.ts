/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Privacy / GDPR helpers (spec §14).
 *
 * `exportAndLeave(session)` runs the user's "give me a copy of
 * everything and forget me" flow:
 *   1. Snapshot the current Y.Doc to IFCX.
 *   2. Clear our awareness state so no stale presence lingers.
 *   3. Dispose the session (closes provider, undo manager, conflict
 *      detector, presence, IDB persistence).
 *
 * The actual server-side hard-delete (room teardown, blob removal,
 * audit-log redaction) is the deployer's responsibility because the
 * client doesn't have that capability — but we expose hooks so apps
 * can trigger it from inside the same call.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type { CollabSession } from './session.js';
import { snapshotToIfcx, type SnapshotOptions } from './snapshot/to-ifcx.js';
import { TOP } from './doc/schema.js';

export interface ExportAndLeaveOptions {
  /** Forwarded to `snapshotToIfcx`. */
  snapshot?: SnapshotOptions;
  /**
   * Optional remote hard-delete trigger. The promise's resolve value
   * is bubbled up in `serverDeletion`.
   */
  serverDelete?: () => Promise<void>;
}

export interface ExportAndLeaveResult {
  ifcx: IfcxFile;
  serverDeletion: 'skipped' | 'ok' | 'failed';
  serverDeletionError?: unknown;
}

export async function exportAndLeave(
  session: CollabSession,
  options: ExportAndLeaveOptions = {},
): Promise<ExportAndLeaveResult> {
  const ifcx = snapshotToIfcx(session.doc, options.snapshot);

  // Clear our presence so peers see us leave cleanly.
  try {
    session.presence.setStatus('offline');
    session.presence.patch({ selection: [], cursor3d: undefined, cursor2d: undefined });
  } catch (err) {
    // Presence channel may already be torn down by the time we get
    // here; non-fatal.
    void err;
  }

  let serverDeletion: ExportAndLeaveResult['serverDeletion'] = 'skipped';
  let serverDeletionError: unknown;
  if (options.serverDelete) {
    try {
      await options.serverDelete();
      serverDeletion = 'ok';
    } catch (err) {
      serverDeletion = 'failed';
      serverDeletionError = err;
    }
  }

  session.dispose();

  return { ifcx, serverDeletion, serverDeletionError };
}

/**
 * Strip user-attributable metadata from a Y.Doc: per-entity `meta` keys
 * `createdBy` / `lastEditedBy`, and per-annotation `authorId` / `authorName`,
 * are blanked. Useful for "anonymise this project" exports. Returns the
 * number of entities + annotations touched.
 *
 * Note: this does NOT touch the underlying CRDT struct authorship
 * (clientID is intrinsic to Yjs's merge semantics and removing it
 * would corrupt the doc). For a proper anonymised export, snapshot
 * to IFCX first — the IFCX serialiser drops clientIDs by design (and
 * doesn't carry annotations at all — markup ≠ BIM, see doc/annotation.ts).
 */
export function redactAuthorMeta(session: CollabSession): number {
  const ents = session.doc.getMap('entities');
  const annotations = session.doc.getMap(TOP.ANNOTATIONS);
  let touched = 0;
  session.doc.transact(() => {
    ents.forEach((entUntyped) => {
      const entity = entUntyped as import('yjs').Map<unknown>;
      const meta = entity.get('meta') as import('yjs').Map<unknown> | undefined;
      if (!meta) return;
      let changed = false;
      if (meta.has('createdBy')) {
        meta.set('createdBy', null);
        changed = true;
      }
      if (meta.has('lastEditedBy')) {
        meta.set('lastEditedBy', null);
        changed = true;
      }
      if (changed) touched += 1;
    });
    annotations.forEach((annUntyped) => {
      const ann = annUntyped as import('yjs').Map<unknown>;
      let changed = false;
      if (ann.has('authorId') && ann.get('authorId') !== '') {
        ann.set('authorId', '');
        changed = true;
      }
      if (ann.has('authorName') && ann.get('authorName') !== '') {
        ann.set('authorName', '');
        changed = true;
      }
      if (changed) touched += 1;
    });
  });
  return touched;
}
