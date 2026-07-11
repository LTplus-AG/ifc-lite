/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Draft publishing from viewer edits (#1717 V2): pending `Mutation`s fold
 * into component-granular ops (`changeSetToOps`), serialize as an IFCX
 * delta document in the same wire dialect the MCP draft tools and the
 * collab snapshot pipeline emit, then freeze into an immutable,
 * content-addressed, provenance-stamped layer on the local store.
 *
 * Identity: for IFCX models the composition PATH is the stable entity
 * identity (the node path is the GUID), so the resolver maps expressId →
 * path via the composition's id bridge. Entities the bridge cannot
 * resolve are reported, never guessed (04-identity.md).
 */

import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
  ATTR,
  IFCLITE_ATTR,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import { changeSetToOps } from '@ifc-lite/mutations';
import type { ChangeSet, ChangeSetOp, Mutation, PropertyValue } from '@ifc-lite/mutations';
import type { BrowserLayerStore } from './browser-store';

const V5A_PREFIX = 'bsi::ifc::v5a::';

/**
 * Canonical wire shape for property values (#1031): scalars wrap in the
 * typed record the collab pipeline emits, so equivalent edits hash
 * identically in the merge engine regardless of the writer.
 */
function typedPropertyRecord(value: PropertyValue): unknown {
  if (typeof value === 'boolean') return { type: 'IfcBoolean', value };
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'IfcInteger' : 'IfcReal', value };
  }
  if (typeof value === 'string') return { type: 'IfcLabel', value };
  return value;
}

/** Wire attribute key + value for one member of a component. */
function wireEntry(
  componentKey: string,
  member: string,
  value: PropertyValue | null,
): { key: string; value: unknown } | null {
  if (componentKey.startsWith('pset:')) {
    const set = componentKey.slice('pset:'.length);
    return { key: `${V5A_PREFIX}${set}::${member}`, value: value === null ? null : typedPropertyRecord(value) };
  }
  if (componentKey.startsWith('qset:')) {
    const set = componentKey.slice('qset:'.length);
    // The quantities branch stores plain finite numbers (inflation
    // unwraps typed records under Qto_* anyway).
    const wire = typeof value === 'number' && Number.isFinite(value) ? value : value === null ? null : typedPropertyRecord(value);
    return { key: `${V5A_PREFIX}${set}::${member}`, value: wire };
  }
  if (componentKey === 'attr:core') {
    // Core attributes travel RAW: the IFCX entity/hierarchy extractors
    // only honor e.g. `bsi::ifc::prop::Name` when the composed value is
    // a plain string — a typed record would compose but never display.
    return { key: `${ATTR.PROP_PREFIX}${member}`, value };
  }
  return null;
}

/**
 * Serialize component ops as IFCX node opinions. Whole-component
 * tombstones null every member visible in the base state — composition
 * is per-attribute LWW, so anything not explicitly nulled shines
 * through.
 */
export function buildDeltaNodes(ops: readonly ChangeSetOp[], baseFiles: readonly IfcxFile[]): IfcxNode[] {
  const baseState = ops.some((op) => op.op === 'tombstone-component')
    ? extractStackState(baseFiles)
    : null;
  const byPath = new Map<string, IfcxNode>();
  const nodeFor = (path: string): IfcxNode => {
    let node = byPath.get(path);
    if (!node) {
      node = { path };
      byPath.set(path, node);
    }
    return node;
  };

  for (const op of ops) {
    const node = nodeFor(op.entity);
    switch (op.op) {
      case 'set-component': {
        for (const [member, value] of Object.entries(op.values)) {
          const entry = wireEntry(op.componentKey, member, value);
          if (entry) node.attributes = { ...node.attributes, [entry.key]: entry.value };
        }
        break;
      }
      case 'tombstone-component': {
        const baseEntity = baseState?.get(op.entity);
        const members = baseEntity?.components.get(op.componentKey);
        for (const key of Object.keys(members ?? {})) {
          node.attributes = { ...node.attributes, [key]: null };
        }
        break;
      }
      case 'add-entity': {
        node.attributes = {
          ...node.attributes,
          ...(op.ifcType ? { [ATTR.CLASS]: { code: op.ifcType } } : {}),
        };
        break;
      }
      case 'tombstone-entity': {
        node.attributes = { ...node.attributes, [IFCLITE_ATTR.DELETED]: true };
        break;
      }
    }
  }

  return [...byPath.values()]
    .filter((node) => node.attributes !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface PublishDraftInit {
  store: BrowserLayerStore;
  /** The composition the edits were made against, weakest first. */
  stackFiles: readonly IfcxFile[];
  /** Pending viewer mutations to freeze. */
  mutations: readonly Mutation[];
  /** expressId → composition path (the layer-stack bridge, inverted). */
  pathOf: (expressId: number) => string | undefined;
  intent: string;
  authorPrincipal: string;
  /** Local ref the published layer appends to. */
  refName: string;
  created?: string;
}

export interface PublishDraftResult {
  layerId: string;
  file: IfcxFile;
  opCount: number;
  /** expressIds with no resolvable identity — excluded from the layer. */
  unresolved: number[];
}

/** Freeze pending edits into a published layer on the local store. */
export function publishViewerDraft(init: PublishDraftInit): PublishDraftResult {
  const changeSet: ChangeSet = {
    id: 'viewer-draft',
    name: init.intent,
    createdAt: Date.now(),
    mutations: [...init.mutations],
    applied: true,
  };
  const { ops, identityMap, unresolved } = changeSetToOps(changeSet, {
    globalIdOf: (expressId) => init.pathOf(expressId),
  });
  const data = buildDeltaNodes(ops, init.stackFiles);
  if (data.length === 0) {
    throw new Error('No publishable changes: every pending edit failed identity resolution or was empty.');
  }

  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: init.authorPrincipal },
    intent: init.intent,
    base: { kind: 'stack', id: computeStackHash(init.stackFiles.map((f) => f.header.id)) },
    identity_map: identityMap,
    created: init.created,
  });

  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: init.authorPrincipal,
      timestamp: manifest.created,
    },
    imports: [],
    schemas: {},
    data,
  };
  const withManifest = setProvenance(bare, manifest);
  const layerId = computeLayerId(withManifest);
  const file: IfcxFile = { ...withManifest, header: { ...withManifest.header, id: layerId } };

  init.store.storeLayer(file);
  const existing = init.store.getRef(init.refName);
  init.store.setRef(init.refName, { layers: [...(existing?.layers ?? []), layerId] });

  return { layerId, file, opCount: ops.length, unresolved };
}
