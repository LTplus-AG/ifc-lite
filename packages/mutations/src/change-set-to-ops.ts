/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * expressId → GlobalId bridge for layer publishing.
 *
 * `Mutation.entityId` is an expressId: model-scoped and unstable across
 * exports. The publish path maps it to a stable identity at freeze time:
 *
 *  1. IFC GlobalId via the store's id table — primary identity
 *  2. Content-derived fallback — blake3 over a stable subset
 *     (ifcType + spatial parent path + name) for entities with missing
 *     GlobalIds, always recorded into the identity map with
 *     `reason: "derived"` so a human can override
 *
 * There is no heuristic matcher: when identity cannot be established the
 * entity is reported in `unresolved` rather than silently guessed.
 *
 * Spec: docs/architecture/layer-prs/04-identity.md §4.1, §4.3.
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ChangeSet, Mutation, PropertyValue } from './types.js';

/** Adapter over the store's id table, supplied by the caller at freeze time. */
export interface EntityIdentityResolver {
  /** The entity's IFC `GlobalId`, when present and trusted. */
  globalIdOf(expressId: number): string | undefined;
  /** IFC type name, used by the content-derived fallback. */
  ifcTypeOf?(expressId: number): string | undefined;
  /** Stable spatial parent path (e.g. `/project/storey-EG`). */
  spatialParentPathOf?(expressId: number): string | undefined;
  /** Entity `Name`, used by the content-derived fallback. */
  nameOf?(expressId: number): string | undefined;
}

/** Identity-map entry mirroring `ifclite::provenance.identity_map`. */
export interface DerivedIdentityEntry {
  base: string;
  here: string;
  reason: string;
}

/**
 * Component-granular semantic ops, in the shared componentKey vocabulary
 * (`pset:<Name>`, `qset:<Name>`, `attr:core`). Values carry only what the
 * change set knows; the publish path composes them onto the draft state.
 */
export type ChangeSetOp =
  | {
      op: 'set-component';
      entity: string;
      componentKey: string;
      /** Property/attribute values; `null` removes the member. */
      values: Record<string, PropertyValue | null>;
    }
  | { op: 'tombstone-component'; entity: string; componentKey: string }
  | { op: 'add-entity'; entity: string; ifcType?: string }
  | { op: 'tombstone-entity'; entity: string };

export interface ChangeSetOpsResult {
  ops: ChangeSetOp[];
  /** Content-derived identities, for the manifest's identity_map. */
  identityMap: DerivedIdentityEntry[];
  /** expressIds for which no identity could be established at all. */
  unresolved: number[];
  /**
   * Mutations with no component representation (unknown/future types).
   * Reported so callers can warn instead of silently under-publishing.
   */
  skipped: Mutation[];
}

const textEncoder = new TextEncoder();

/** Content-derived fallback identity (04 §4.1(3)). */
export function deriveEntityIdentity(input: {
  ifcType?: string;
  spatialParentPath?: string;
  name?: string;
}): string {
  const canonical = JSON.stringify({
    ifcType: input.ifcType ?? '',
    name: input.name ?? '',
    spatialParentPath: input.spatialParentPath ?? '',
  });
  return `derived:${bytesToHex(blake3(textEncoder.encode(canonical)))}`;
}

/**
 * Map a change set's mutations onto component-granular ops keyed by
 * stable entity identity. Mutations fold LWW per (entity, componentKey)
 * in change-set order, matching layer composition semantics.
 */
export function changeSetToOps(
  changeSet: ChangeSet,
  resolver: EntityIdentityResolver
): ChangeSetOpsResult {
  const identityCache = new Map<number, string | undefined>();
  const identityMap: DerivedIdentityEntry[] = [];
  const unresolved: number[] = [];

  const identityOf = (expressId: number): string | undefined => {
    if (identityCache.has(expressId)) return identityCache.get(expressId);
    let identity = resolver.globalIdOf(expressId);
    if (identity === undefined) {
      const ifcType = resolver.ifcTypeOf?.(expressId);
      const name = resolver.nameOf?.(expressId);
      const spatialParentPath = resolver.spatialParentPathOf?.(expressId);
      if (ifcType !== undefined || name !== undefined || spatialParentPath !== undefined) {
        identity = deriveEntityIdentity({ ifcType, name, spatialParentPath });
        identityMap.push({ base: identity, here: identity, reason: 'derived' });
      } else {
        unresolved.push(expressId);
      }
    }
    identityCache.set(expressId, identity);
    return identity;
  };

  // Fold per (entity, componentKey); entity-level ops tracked separately.
  const components = new Map<string, Map<string, Record<string, PropertyValue | null> | null>>();
  const entityOps = new Map<string, ChangeSetOp>();

  const componentFor = (entity: string, componentKey: string) => {
    let perEntity = components.get(entity);
    if (!perEntity) {
      perEntity = new Map();
      components.set(entity, perEntity);
    }
    return perEntity;
  };

  const setMember = (
    entity: string,
    componentKey: string,
    member: string,
    value: PropertyValue | null
  ) => {
    const perEntity = componentFor(entity, componentKey);
    const existing = perEntity.get(componentKey);
    const values = existing === null || existing === undefined ? {} : existing;
    values[member] = value;
    perEntity.set(componentKey, values);
  };

  const skipped: Mutation[] = [];
  for (const mutation of changeSet.mutations) {
    const entity = identityOf(mutation.entityId);
    if (entity === undefined) continue;
    applyMutation(mutation, entity, setMember, componentFor, entityOps, resolver, skipped);
  }

  const ops: ChangeSetOp[] = [...entityOps.values()];
  // Component ops fold in mutation order alongside entityOps above, but an
  // entity's terminal state (LWW over entityOps) is only known once the
  // whole mutation list has been consumed. Filter here, after both are
  // complete, rather than during the fold: a DELETE_ENTITY appearing after
  // the property mutation that produced a component would otherwise be
  // missed by an in-flight check (the same forward-pass hazard as #2044).
  // An entity tombstoned and later recreated (DELETE_ENTITY then
  // CREATE_ENTITY for the same identity) resolves to 'add-entity' here,
  // since entityOps is itself LWW keyed by entity — so its components
  // correctly survive.
  for (const [entity, perEntity] of components) {
    if (entityOps.get(entity)?.op === 'tombstone-entity') continue;
    for (const [componentKey, values] of perEntity) {
      if (values === null) {
        ops.push({ op: 'tombstone-component', entity, componentKey });
      } else {
        ops.push({ op: 'set-component', entity, componentKey, values });
      }
    }
  }

  return { ops, identityMap, unresolved, skipped };
}

function applyMutation(
  mutation: Mutation,
  entity: string,
  setMember: (entity: string, componentKey: string, member: string, value: PropertyValue | null) => void,
  componentFor: (entity: string, componentKey: string) => Map<string, Record<string, PropertyValue | null> | null>,
  entityOps: Map<string, ChangeSetOp>,
  resolver: EntityIdentityResolver,
  skipped: Mutation[]
): void {
  switch (mutation.type) {
    case 'CREATE_PROPERTY':
    case 'UPDATE_PROPERTY':
      if (mutation.psetName && mutation.propName) {
        setMember(entity, `pset:${mutation.psetName}`, mutation.propName, mutation.newValue ?? null);
      }
      break;
    case 'DELETE_PROPERTY':
      if (mutation.psetName && mutation.propName) {
        setMember(entity, `pset:${mutation.psetName}`, mutation.propName, null);
      }
      break;
    case 'CREATE_QUANTITY':
    case 'UPDATE_QUANTITY':
      if (mutation.psetName && mutation.propName) {
        setMember(entity, `qset:${mutation.psetName}`, mutation.propName, mutation.newValue ?? null);
      } else if (mutation.type === 'CREATE_QUANTITY' && mutation.psetName && Array.isArray(mutation.newValue)) {
        // `MutablePropertyView.createQuantitySet()` (whole-qset creation, e.g.
        // `StoreEditor.addQuantitySet`) records ONE CREATE_QUANTITY mutation for
        // the whole set — no `propName`, `newValue` is the full quantities array
        // — unlike `setQuantity()`'s per-quantity CREATE_QUANTITY, which always
        // carries both. Without this branch the `psetName && propName` check
        // above is false and the mutation fell through with nothing published:
        // not even into `skipped` (it matches this case, so the default branch
        // never runs), so a freshly-created quantity set vanished from the
        // layer with zero trace.
        const qsetComponentKey = `qset:${mutation.psetName}`;
        // Materialize the (possibly empty) set — mirrors CREATE_PROPERTY_SET
        // below. `createQuantitySet(entity, name, [])` is a legal call (a set
        // created with zero quantities, to be populated later); without this
        // line the loop below runs zero times and never touches `components`,
        // so the whole set still vanished with zero trace for exactly the
        // empty-array case — the same #2263 shape surviving in a corner the
        // original fix didn't cover.
        componentFor(entity, qsetComponentKey).set(qsetComponentKey, {});
        for (const q of mutation.newValue as Array<{ name?: string; value?: PropertyValue }>) {
          if (q && typeof q.name === 'string') {
            setMember(entity, qsetComponentKey, q.name, q.value ?? null);
          }
        }
      }
      break;
    case 'DELETE_QUANTITY':
      if (mutation.psetName && mutation.propName) {
        setMember(entity, `qset:${mutation.psetName}`, mutation.propName, null);
      }
      break;
    case 'CREATE_PROPERTY_SET':
      if (mutation.psetName) {
        const componentKey = `pset:${mutation.psetName}`;
        // Materialize the (possibly empty) set.
        componentFor(entity, componentKey).set(componentKey, {});
        // `MutablePropertyView.createPropertySet()` (whole-pset creation, e.g.
        // `StoreEditor.addPropertySet`) records ONE CREATE_PROPERTY_SET mutation
        // for the whole set — `newValue` is the full properties array — and does
        // NOT also push a separate CREATE_PROPERTY mutation per member into
        // `mutationHistory`. "members follow" was therefore never true for this
        // path: nothing else in the change set ever populated `values`, so the
        // published set-component op carried `values: {}` and every property the
        // user entered was silently dropped from the layer.
        if (Array.isArray(mutation.newValue)) {
          for (const prop of mutation.newValue as Array<{ name?: string; value?: PropertyValue }>) {
            if (prop && typeof prop.name === 'string') {
              setMember(entity, componentKey, prop.name, prop.value ?? null);
            }
          }
        }
      }
      break;
    case 'DELETE_PROPERTY_SET':
      if (mutation.psetName) {
        componentFor(entity, `pset:${mutation.psetName}`).set(`pset:${mutation.psetName}`, null);
      }
      break;
    case 'UPDATE_ATTRIBUTE':
    case 'UPDATE_POSITIONAL_ATTRIBUTE':
      if (mutation.attributeName) {
        setMember(entity, 'attr:core', mutation.attributeName, mutation.newValue ?? null);
      }
      break;
    case 'CREATE_ENTITY':
      entityOps.set(entity, {
        op: 'add-entity',
        entity,
        ifcType: resolver.ifcTypeOf?.(mutation.entityId),
      });
      break;
    case 'DELETE_ENTITY':
      entityOps.set(entity, { op: 'tombstone-entity', entity });
      break;
    case 'UPDATE_ENTITY_TYPE':
      // Retype = a class-component opinion; the wire layer serializes it
      // as `bsi::ifc::class` (code only, like add-entity). PredefinedType
      // rides the core-attribute channel; explicit null clears it.
      if (mutation.entityType) {
        setMember(entity, 'attr:class', 'code', mutation.entityType);
        if (mutation.predefinedType !== undefined) {
          setMember(entity, 'attr:core', 'PredefinedType', mutation.predefinedType);
        }
      }
      break;
    default:
      // Runtime data may carry mutation types this build does not know
      // (forward compat): report, never silently under-publish.
      skipped.push(mutation);
      break;
  }
}
