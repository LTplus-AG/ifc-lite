/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `speckle.receive` — fetch one Speckle model version (or object) and write
 * its walls, floors, roofs, columns and beams into the model under a target
 * storey (#5167 phase 3.6). The mapping is `speckle/mapping.ts`
 * (docs/architecture/speckle-mapping.md); the wire protocol is
 * `speckle/client.ts`, which reaches the network ONLY through the gated
 * `coreNetworkRequest` with this host's `networkGrants` and
 * `networkTransport` — so the graph must declare
 * `network.fetch:<speckle host>` and a token comes in as
 * `{{secret:NAME}}`, exactly as for `http.request`.
 *
 * Identity: each element's GlobalId is derived from the server origin, the
 * project id and the element's Revit `applicationId` (its Speckle id when
 * absent), so receiving
 * a later version of the same model REPLACES the elements an earlier
 * receive wrote instead of duplicating them. Elements that disappeared from
 * the newer version are not removed (v1; the node is not a tracked set).
 * Replacing needs `model.delete`, checked only when there is something to
 * replace; the new element is written before the old one is removed.
 */

import { trackingGuid, type EntityRef } from '@ifc-lite/flow';
import type { EntityRef as SdkEntityRef } from '@ifc-lite/sdk';
import { ANY_ITEM, ENTITY_ITEM, ENTITY_LIST, SCALAR_ITEM, rememberGlobalId, requireCapability, resolveByGlobalId, toSdkRef, type Ctx, type FlowNodeDef } from './host.js';
import { fetchObjectGraph, resolveRoot, type SpeckleClientOptions } from './speckle/client.js';
import { mapSpeckleGraph, PSET_INSTANCE, PSET_SOURCE, PSET_TYPE, type PlannedElement } from './speckle/mapping.js';
import type { RefusalLog } from './speckle/refusals.js';
import { parseSpeckleUrl, type SpeckleTarget } from './speckle/url.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OBJECTS = 50_000;
const PSETS = [PSET_SOURCE, PSET_TYPE, PSET_INSTANCE] as const;

function positive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function targetOf(p: Readonly<Record<string, unknown>>): SpeckleTarget {
  if (text(p.url).length > 0) return parseSpeckleUrl(text(p.url));
  const server = text(p.server);
  const projectId = text(p.projectId);
  const objectId = text(p.objectId);
  if (!server || !projectId || !objectId) {
    throw new Error('speckle.receive: give either "url", or all of "server", "projectId" and "objectId"');
  }
  return parseSpeckleUrl(`${server.replace(/\/+$/, '')}/streams/${projectId}/objects/${objectId}`);
}

function write(ctx: Ctx, storey: SdkEntityRef, e: PlannedElement, GlobalId: string): SdkEntityRef {
  const store = ctx.host.bim.store;
  switch (e.kind) {
    case 'wall': return store.addWall(storey.modelId, storey.expressId, { ...e.params, GlobalId });
    case 'slab': return store.addSlab(storey.modelId, storey.expressId, { ...e.params, GlobalId });
    case 'roof': return store.addRoof(storey.modelId, storey.expressId, { ...e.params, GlobalId });
    case 'column': return store.addColumn(storey.modelId, storey.expressId, { ...e.params, GlobalId });
    case 'beam': return store.addBeam(storey.modelId, storey.expressId, { ...e.params, GlobalId });
  }
}

/**
 * The identity namespace of one Speckle project: the server's normalised
 * origin AND the project id, so the same project id on two servers can
 * never mint the same GlobalIds.
 */
export function identityScope(server: string, projectId: string): string {
  return `speckle:${new URL(server).origin}/${projectId}`;
}

function writeAll(ctx: Ctx, storey: SdkEntityRef, scope: string, planned: readonly PlannedElement[], log: RefusalLog): EntityRef[] {
  const bim = ctx.host.bim;
  const entities: EntityRef[] = [];
  const counts = { created: 0, replaced: 0, kept: 0 };
  const keys = new Set<string>();
  // Resolve every slot BEFORE writing: a missing `model.delete` grant must
  // refuse the receive before anything is written, not halfway through
  // (a batch groups undo; it does not roll back a throw).
  const slots = planned.map((e) => {
    // Two objects sharing an applicationId in one version must not replace
    // each other: the second falls back to its (content-hash) Speckle id.
    const key = keys.has(e.key) ? e.speckleId : e.key;
    keys.add(key);
    const globalId = trackingGuid(scope, key);
    return { e, globalId, existing: resolveByGlobalId(bim, globalId) };
  });
  if (slots.some((s) => s.existing)) requireCapability(ctx, 'model.delete');
  bim.mutate.batch('speckle.receive', () => {
    for (const { e, globalId, existing } of slots) {
      // The new element is written FIRST, beside the old one: a write the
      // builder rejects must leave the previous receive's element in place.
      let ref: SdkEntityRef;
      try {
        ref = write(ctx, storey, e, globalId);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (existing) {
          counts.kept++;
          log.add(e.speckleType, 'write-failed-kept-previous', `the IFC writer rejected the new version (${why}); the element from the earlier receive was kept`, e.speckleId);
        } else {
          log.add(e.speckleType, 'write-failed', `the IFC writer rejected it (${why})`, e.speckleId);
        }
        continue;
      }
      if (existing && !bim.store.removeEntity(existing)) {
        // Roll the new element back rather than leave two under one GlobalId.
        bim.store.removeEntity(ref);
        counts.kept++;
        log.add(e.speckleType, 'write-failed-kept-previous', 'the element from the earlier receive could not be removed, so it was kept and the new version not written', e.speckleId);
        continue;
      }
      rememberGlobalId(bim, globalId, ref);
      for (const pset of PSETS) {
        for (const [prop, value] of Object.entries(e.psets[pset] ?? {})) bim.mutate.setProperty(ref, pset, prop, value);
      }
      counts[existing ? 'replaced' : 'created']++;
      entities.push({ globalId, modelId: ref.modelId, expressId: ref.expressId });
      log.add(e.speckleType, 'display-meshes', 'bim.store has no tessellated-body writer, so the body is rebuilt parametrically from the location and dimensions', e.speckleId, e.displayMeshes);
      log.add(e.speckleType, 'non-parameter-entries', 'they carry no scalar value (compound structure layers, nested tables)', e.speckleId, e.skippedEntries);
    }
  });
  ctx.log('info', `speckle.receive: ${counts.created} created, ${counts.replaced} replaced from an earlier receive, ${counts.kept} earlier element(s) kept after a failed write`);
  return entities;
}

async function run(ctx: Ctx, inputs: Readonly<Record<string, unknown>>, p: Readonly<Record<string, unknown>>) {
  requireCapability(ctx, 'model.create');
  for (const pset of PSETS) requireCapability(ctx, `model.mutate:${pset}`);
  const storey = toSdkRef(ctx, inputs.storey as EntityRef);
  const target = targetOf(p);
  const opts: SpeckleClientOptions = {
    grants: ctx.host.networkGrants ?? [],
    transport: ctx.host.networkTransport,
    token: text(p.token),
    timeoutMs: positive(p.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxBytes: positive(p.maxBytes, DEFAULT_MAX_BYTES),
    maxObjects: positive(p.maxObjects, DEFAULT_MAX_OBJECTS),
    signal: ctx.signal,
  };
  const root = await resolveRoot(opts, target);
  const objects = await fetchObjectGraph(opts, target, root.objectId);
  const { planned, refusals } = mapSpeckleGraph(objects, root.objectId, { level: text(p.level) || undefined });
  const entities = writeAll(ctx, storey, identityScope(target.server, target.projectId), planned, refusals);
  const refused = refusals.list();
  for (const r of refused) ctx.log('warn', r.message);
  return { entities, refusals: refused, objectId: root.objectId, versionId: root.versionId ?? null };
}

export const speckleReceiveNode: FlowNodeDef = {
  type: 'speckle.receive',
  title: 'Speckle receive',
  category: 'network',
  doc:
    'Fetches a Speckle model version and writes its walls, floors, flat roofs, columns and beams into the target storey, with Revit parameters as property sets. ' +
    'Everything it cannot map is reported by type, reason and count. Needs a granted network.fetch:<speckle host>; a token goes in as {{secret:NAME}}.',
  inputs: [{ name: 'storey', type: ENTITY_ITEM }],
  outputs: [
    { name: 'entities', type: ENTITY_LIST },
    { name: 'refusals', type: ANY_ITEM },
    { name: 'objectId', type: SCALAR_ITEM },
    { name: 'versionId', type: SCALAR_ITEM, nullable: true },
  ],
  params: [
    { name: 'url', kind: 'string', default: '', doc: 'https://<server>/projects/<project>/models/<model>[@<version>], or a legacy /streams/<stream>/commits/<commit> or /streams/<stream>/objects/<object> URL.' },
    { name: 'server', kind: 'string', default: '', doc: 'With projectId and objectId, instead of url: e.g. https://app.speckle.systems' },
    { name: 'projectId', kind: 'string', default: '', doc: 'Project (stream) id, used with server and objectId.' },
    { name: 'objectId', kind: 'string', default: '', doc: 'Root object id, used with server and projectId.' },
    { name: 'token', kind: 'string', default: '', doc: 'Personal access token for a private project. Use {{secret:NAME}}; never paste the token itself.' },
    { name: 'level', kind: 'string', default: '', doc: 'Only receive elements on this Speckle level (by name). Empty receives every level.' },
    { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS },
    { name: 'maxBytes', kind: 'number', default: DEFAULT_MAX_BYTES, doc: 'Per-response byte cap; a response past it fails the receive.' },
    { name: 'maxObjects', kind: 'number', default: DEFAULT_MAX_OBJECTS, doc: 'Upper bound on objects fetched (display meshes are never fetched).' },
  ],
  capabilities: ['model.create', 'model.delete', ...PSETS.map((p) => `model.mutate:${p}`), 'network.fetch:*'],
  writes: 'model',
  requires: { network: true, backend: ['store', 'mutate'] },
  // The server is the source of truth: a cached run would never see a new version.
  volatile: true,
  run,
};
