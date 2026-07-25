/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, RevisionEvent, RevisionWatchResult, SourceFileRef } from '@ifc-lite/plugin-api';

import { decodeContainerId } from './ids.js';
import { GraphApiError, MAX_SWEEP_PAGES, graphGetJson, type GraphTokenSource } from './graph-client.js';
import type { GraphDriveItem, GraphPage } from './graph-types.js';

// ============================================================================
// Change detection via Graph's `/delta` endpoint.
//
// The plugin contract gives `watchRevisions` exactly one opaque `cursor`
// string, but a delta feed is scoped to a single drive
// (`/drives/{driveId}/root/delta`) and the tracked refs can span several
// drives. Since the cursor is provider-defined and opaque to the host, this
// packs a `{ [driveId]: deltaLink }` map into it — one JSON string standing
// in for as many delta streams as there are drives in play.
// ============================================================================

interface DeltaCursorState {
  [driveId: string]: string;
}

/**
 * Thin, explicitly-typed wrapper around `graphGetJson` for delta pages.
 * Inlining the generic call directly inside the `while` loops below trips a
 * TS6 inference quirk (TS7022, "implicitly has type 'any' ... referenced in
 * its own initializer") against a loop variable it's assigned to — giving
 * the call its own named function with an explicit return type sidesteps it.
 */
async function fetchDeltaPage(
  ctx: PluginContext,
  auth: GraphTokenSource,
  link: string,
  signal: AbortSignal | undefined,
): Promise<GraphPage<GraphDriveItem>> {
  return graphGetJson<GraphPage<GraphDriveItem>>(ctx, auth, link, { signal });
}

/**
 * Parses a persisted cursor defensively. The host only ever saves a new
 * cursor after a successful `watchRevisions` call, so a bad value here — a
 * `JSON.parse` result that isn't a plain object (`null`, an array, a number),
 * or one whose values aren't the `driveId -> deltaLink` strings this shape
 * requires — has no path to self-heal: it would otherwise wedge change
 * detection for the affected project forever, since nothing else ever
 * overwrites it. Any deviation from the expected shape is treated as "no
 * baseline yet" rather than thrown, and unusable entries are dropped
 * individually rather than discarding the whole cursor.
 */
function parseCursor(cursor: string | undefined): DeltaCursorState {
  if (!cursor) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const state: DeltaCursorState = {};
  for (const [driveId, link] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof link === 'string') state[driveId] = link;
  }
  return state;
}

/**
 * Establishes a delta baseline for a drive without replaying its entire
 * history as "new" events. `?token=latest` is Graph's documented shortcut
 * for exactly this: "watch files I already loaded", returning an empty page
 * plus a fresh `@odata.deltaLink` immediately.
 */
async function seedDeltaLink(
  ctx: PluginContext,
  auth: GraphTokenSource,
  driveId: string,
  signal?: AbortSignal,
): Promise<string> {
  const page = await fetchDeltaPage(
    ctx,
    auth,
    `/drives/${encodeURIComponent(driveId)}/root/delta?token=latest`,
    signal,
  );
  const link = page['@odata.deltaLink'] ?? page['@odata.nextLink'];
  if (!link) {
    throw new Error(
      `Graph delta?token=latest for drive ${driveId} returned neither a deltaLink nor a nextLink.`,
    );
  }
  return link;
}

/**
 * Follows one drive's delta stream from its stored link to the end,
 * returning changed items and the new deltaLink. Bounded by `MAX_SWEEP_PAGES`
 * and a repeated-link guard, mirroring `graphListAll` — a buggy upstream
 * re-issuing the same `nextLink` would otherwise poll forever instead of
 * failing visibly.
 */
async function drainDelta(
  ctx: PluginContext,
  auth: GraphTokenSource,
  startLink: string,
  signal?: AbortSignal,
): Promise<{ items: GraphDriveItem[]; deltaLink: string | undefined }> {
  const items: GraphDriveItem[] = [];
  let link: string | undefined = startLink;
  let deltaLink: string | undefined;
  let pageCount = 0;

  while (link) {
    const page = await fetchDeltaPage(ctx, auth, link, signal);
    items.push(...page.value);
    deltaLink = page['@odata.deltaLink'];
    const nextLink = page['@odata.nextLink'];
    if (nextLink && nextLink === link) {
      throw new Error('Graph delta pagination re-issued the same nextLink — refusing to loop forever');
    }
    pageCount += 1;
    if (pageCount > MAX_SWEEP_PAGES) {
      throw new Error(`Graph delta pagination exceeded ${MAX_SWEEP_PAGES} pages without finishing`);
    }
    link = nextLink;
  }

  return { items, deltaLink };
}

/** `ctx.storage` key holding the last-seen cTag for one tracked file, so a
 * metadata-only delta hit (rename, move, permission change) — which surfaces
 * the item with an unchanged cTag — can be told apart from a real content
 * change. */
function ctagStorageKey(driveId: string, itemId: string): string {
  return `msgraph:ctag:${driveId}:${itemId}`;
}

/**
 * Implements `FileSourceProvider.watchRevisions` for Microsoft Graph. Cheaper
 * per-file alternative some callers may prefer (not implemented here, since
 * the delta feed already gives us this for free): comparing `cTag` across
 * polls, which only changes on content change, not metadata.
 */
export async function watchDriveRevisions(
  ctx: PluginContext,
  auth: GraphTokenSource,
  refs: readonly SourceFileRef[],
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<RevisionWatchResult> {
  const state = parseCursor(cursor);

  const refsByDrive = new Map<string, SourceFileRef[]>();
  for (const ref of refs) {
    const { driveId } = decodeContainerId(ref.containerId);
    const list = refsByDrive.get(driveId);
    if (list) list.push(ref);
    else refsByDrive.set(driveId, [ref]);
  }

  // Keep polling any drive the cursor already tracks even if today's refs
  // don't mention it (e.g. its last-loaded file was just unloaded from the
  // scene), so its deltaLink is never silently dropped and rediscovered as
  // one giant backlog later.
  const driveIds = new Set([...refsByDrive.keys(), ...Object.keys(state)]);

  const events: RevisionEvent[] = [];
  const nextState: DeltaCursorState = { ...state };

  for (const driveId of driveIds) {
    const existingLink = state[driveId];

    try {
      if (!existingLink) {
        nextState[driveId] = await seedDeltaLink(ctx, auth, driveId, signal);
        continue;
      }

      const driveRefs = refsByDrive.get(driveId) ?? [];
      const refByItemId = new Map(driveRefs.map((ref) => [ref.fileId, ref] as const));

      const { items, deltaLink } = await drainDelta(ctx, auth, existingLink, signal);
      for (const item of items) {
        const ref = refByItemId.get(item.id);
        if (!ref) continue; // Changed upstream, but not a file this host is tracking.

        const cacheKey = ctagStorageKey(driveId, item.id);
        const latestRevisionId = item.cTag ?? item.eTag ?? item.id;
        // The delta feed surfaces an item for *any* change — a rename, a
        // move, a permission edit — not just a content change. Comparing
        // against `ref.revisionId` alone (what the host says it last loaded)
        // would still fire on those, since the host's copy is genuinely
        // "behind" the item's own metadata timestamp even when the bytes
        // never moved. The stored cTag is the actual last-observed content
        // identity; seed it from `ref.revisionId` the first time this file is
        // seen so a real change since the host's last load is still reported.
        const previousRevisionId = (await ctx.storage.get(cacheKey)) ?? ref.revisionId;

        if (item.deleted !== undefined) {
          events.push({ fileId: item.id, latestRevisionId, previousRevisionId, deleted: true });
          await ctx.storage.delete(cacheKey);
          continue;
        }

        if (previousRevisionId !== latestRevisionId) {
          events.push({ fileId: item.id, latestRevisionId, previousRevisionId });
        }
        await ctx.storage.set(cacheKey, latestRevisionId);
      }

      nextState[driveId] = deltaLink ?? existingLink;
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 410) {
        // The stored deltaLink is gone (Graph documents this as an expected,
        // occasional occurrence). We cannot know what changed in between, so
        // resync silently rather than raise — the next poll starts a fresh
        // baseline and simply won't report the changes that happened during
        // the gap.
        ctx.log.warn('Graph delta link expired (410); resyncing without replaying missed changes', {
          driveId,
        });
        nextState[driveId] = await seedDeltaLink(ctx, auth, driveId, signal);
        continue;
      }
      if (err instanceof GraphApiError && (err.status === 404 || err.status === 403)) {
        // The drive itself is gone or no longer reachable (deleted, or access
        // revoked). We deliberately keep every drive the cursor already
        // tracks in `driveIds` above so its progress survives an unrelated
        // day with no matching refs — but that means a dead drive would
        // otherwise re-fail this exact request on every single poll forever.
        // Drop it from the cursor so it stops being polled; a healthy drive's
        // events collected earlier in this same loop are unaffected.
        ctx.log.warn('Graph drive no longer accessible; dropping it from change detection', {
          driveId,
          status: err.status,
        });
        delete nextState[driveId];
        continue;
      }
      throw err;
    }
  }

  return { events, cursor: JSON.stringify(nextState) };
}
