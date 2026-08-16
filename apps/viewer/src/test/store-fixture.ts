/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store seeds for viewer component tests (#2434).
 *
 * Most viewer panels gate their whole body on there being an active model with
 * an `ifcDataStore`, then read a handful of indexes off it during render. A
 * test that only cares about, say, row-click wiring still has to get past that
 * gate — and discovering which three fields the render path touches is most of
 * the cost of writing the first behavioural test for a panel. Doing it once
 * here is the difference between "mountable" and "not worth it".
 *
 * The stub is deliberately minimal and honest: it satisfies the render path and
 * nothing more. A test that needs real parsed data should build a real store
 * (see `useIfcCache.staleness.test.tsx` for that pattern) rather than growing
 * this one until it pretends to be a parser.
 */

import { RelationshipType } from '@ifc-lite/data';
import type { FederatedModel } from '@/store';
import type { IfcDataStore } from '@ifc-lite/parser';

/** An entity the fixture store knows about. */
export interface FixtureEntity {
  expressId: number;
  /** Canonical PascalCase type, e.g. `IfcWall`. */
  type: string;
  name?: string;
  /** 22-char IFC GlobalId. Only needed by tests that search by GUID. */
  globalId?: string;
  description?: string;
  objectType?: string;
}

/**
 * The smallest object that survives a viewer panel's render path: an
 * `entityIndex.byType` map and an `entities` accessor. `spatialHierarchy` is
 * left undefined, which `collectStoreys` handles by returning no storeys.
 *
 * `entities` also carries the COLUMNAR half of the real `EntityTable`
 * (`expressId` / `name` / `globalId` / `description` / `objectType` /
 * `typeEnum` typed arrays plus a `strings` table), because search is not a
 * per-id lookup: `runTier0Scan` and `buildTier1Index` walk the columns
 * directly. Without them a search component mounts and finds nothing, which
 * makes every downstream assertion vacuously true rather than red.
 * Index 0 of the string table is the canonical empty string, exactly as the
 * parser's `StringTable` defines it — both scanners use `idx === 0` as their
 * "row has no searchable text" fast skip.
 */
export function fixtureDataStore(
  entities: FixtureEntity[] = [],
  options: {
    /** `IfcRelAggregates` adjacency (parent express id -> child express ids).
     *  When given, the store carries a minimal `relationships.getRelated`
     *  satisfying `AggregationRelationships`, so aggregation-walking paths
     *  (assembly expansion, basket visibility) become exercisable. */
    aggregates?: Record<number, number[]>;
  } = {},
): IfcDataStore {
  const byType = new Map<string, number[]>();
  const byId = new Map<number, FixtureEntity>();
  for (const e of entities) {
    const key = e.type.toUpperCase();
    const ids = byType.get(key);
    if (ids) ids.push(e.expressId);
    else byType.set(key, [e.expressId]);
    byId.set(e.expressId, e);
  }

  const strings: string[] = [''];
  const intern = (value: string | undefined): number => {
    if (!value) return 0;
    const existing = strings.indexOf(value);
    if (existing > 0) return existing;
    return strings.push(value) - 1;
  };
  const column = (pick: (e: FixtureEntity) => string | undefined): Uint32Array =>
    Uint32Array.from(entities, (e) => intern(pick(e)));

  const expressIdCol = Uint32Array.from(entities, (e) => e.expressId);
  const nameCol = column((e) => e.name);
  const globalIdCol = column((e) => e.globalId);
  const descriptionCol = column((e) => e.description);
  const objectTypeCol = column((e) => e.objectType);
  const byGlobalId = new Map<string, number>();
  for (const e of entities) if (e.globalId) byGlobalId.set(e.globalId, e.expressId);

  // ONE cast, here, rather than at every call site. It is narrow on purpose:
  // widening this object until it structurally satisfies IfcDataStore would
  // mean reimplementing the parser, and a per-test cast would silence the next
  // field a test genuinely needs. If a render path reaches past these three,
  // it belongs in this fixture — add it here and the cast stays honest.
  const { aggregates } = options;
  return {
    entityIndex: { byType },
    spatialHierarchy: undefined,
    ...(aggregates
      ? {
          relationships: {
            getRelated: (id: number, relType: RelationshipType, direction: 'forward' | 'inverse') =>
              relType === RelationshipType.Aggregates && direction === 'forward'
                ? [...(aggregates[id] ?? [])]
                : [],
          },
        }
      : {}),
    strings: { get: (idx: number) => strings[idx] ?? '' },
    entities: {
      getTypeName: (id: number) => byId.get(id)?.type ?? null,
      getName: (id: number) => byId.get(id)?.name ?? null,
      getDescription: (id: number) => byId.get(id)?.description ?? '',
      getObjectType: (id: number) => byId.get(id)?.objectType ?? '',
      getExpressIdByGlobalId: (guid: string) => byGlobalId.get(guid) ?? 0,
      count: entities.length,
      expressId: expressIdCol,
      // Every fixture row is "some product"; no scanner branches on the value,
      // they only carry it through into the index entry.
      typeEnum: new Uint16Array(entities.length),
      name: nameCol,
      globalId: globalIdCol,
      description: descriptionCol,
      objectType: objectTypeCol,
    },
  } as unknown as IfcDataStore;
}

/**
 * One federated model entry, shaped the way `modelSlice` stores it. `idOffset`
 * is what `toGlobalIdFromModels` adds to an expressId, so a non-zero value here
 * is what makes a test catch code that forgets to qualify an id.
 */
export function fixtureModel(
  id: string,
  options: { idOffset?: number; entities?: FixtureEntity[]; aggregates?: Record<number, number[]> } = {},
): FederatedModel {
  return {
    id,
    name: id,
    // Panels filter the federation on `visible`; defaulting it false would
    // silently exercise the hidden path in every test that seeds a model.
    visible: true,
    idOffset: options.idOffset ?? 0,
    ifcDataStore: fixtureDataStore(options.entities, { aggregates: options.aggregates }),
  } as unknown as FederatedModel;
}

/** `models` map + `activeModelId`, the pair every panel reads together. */
export function fixtureModels(...models: FederatedModel[]): {
  models: Map<string, FederatedModel>;
  activeModelId: string | null;
} {
  return {
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: models[0]?.id ?? null,
  };
}
