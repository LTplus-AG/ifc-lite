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

import type { FederatedModel } from '@/store';
import type { IfcDataStore } from '@ifc-lite/parser';

/** An entity the fixture store knows about. */
export interface FixtureEntity {
  expressId: number;
  /** Canonical PascalCase type, e.g. `IfcWall`. */
  type: string;
  name?: string;
}

/**
 * The smallest object that survives a viewer panel's render path: an
 * `entityIndex.byType` map and an `entities` accessor. `spatialHierarchy` is
 * left undefined, which `collectStoreys` handles by returning no storeys.
 */
export function fixtureDataStore(entities: FixtureEntity[] = []): IfcDataStore {
  const byType = new Map<string, number[]>();
  const byId = new Map<number, FixtureEntity>();
  for (const e of entities) {
    const key = e.type.toUpperCase();
    const ids = byType.get(key);
    if (ids) ids.push(e.expressId);
    else byType.set(key, [e.expressId]);
    byId.set(e.expressId, e);
  }
  // ONE cast, here, rather than at every call site. It is narrow on purpose:
  // widening this object until it structurally satisfies IfcDataStore would
  // mean reimplementing the parser, and a per-test cast would silence the next
  // field a test genuinely needs. If a render path reaches past these three,
  // it belongs in this fixture — add it here and the cast stays honest.
  return {
    entityIndex: { byType },
    spatialHierarchy: undefined,
    entities: {
      getTypeName: (id: number) => byId.get(id)?.type ?? null,
      getName: (id: number) => byId.get(id)?.name ?? null,
      count: byId.size,
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
  options: { idOffset?: number; entities?: FixtureEntity[] } = {},
): FederatedModel {
  return {
    id,
    name: id,
    // Panels filter the federation on `visible`; defaulting it false would
    // silently exercise the hidden path in every test that seeds a model.
    visible: true,
    idOffset: options.idOffset ?? 0,
    ifcDataStore: fixtureDataStore(options.entities),
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
