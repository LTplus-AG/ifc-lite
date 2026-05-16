/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthetic fixture support for the test runner.
 *
 * The authoring loop's tests need to run against *something* — but
 * shipping real IFC files in every bundle's `tests/models/` is heavy
 * and brittle. Synthetic fixtures fix this by constructing a small
 * in-memory mock `bim` ctx from a structured spec:
 *
 *   {
 *     schema: 'IFC4',
 *     elements: {
 *       IfcWall: 12,
 *       IfcSlab: 4,
 *     },
 *   }
 *
 * Test handlers see a `ctx.bim` whose `query.byType(type)` returns
 * sequential pseudo-entity-ids matching the declared count. This is
 * deliberately minimalist: enough surface to exercise the call shape
 * of an authored handler, not enough to mimic real IFC semantics. The
 * test runner consumes the result via the `loadFixture` callback we
 * already plumbed in.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §7.2.
 */

export interface SyntheticFixtureSpec {
  /** Display id (used to resolve `fixture: "<name>"` in manifest.tests). */
  id: string;
  /** Schema version surfaced via ctx.bim.schema. */
  schema?: string;
  /** Map of IFC type → entity count to fabricate. */
  elements?: Record<string, number>;
  /** Optional extra properties merged into ctx.bim. */
  extra?: Record<string, unknown>;
}

export interface SyntheticEntity {
  expressId: number;
  type: string;
  props: Record<string, unknown>;
}

export interface SyntheticBim {
  schema: string;
  isSynthetic: true;
  entities: SyntheticEntity[];
  query: {
    byType(type: string): SyntheticEntity[];
    count(type?: string): number;
  };
  [key: string]: unknown;
}

/**
 * Build a synthetic bim ctx from a fixture spec. Returns the same
 * shape the production sandbox `ctx.bim` exposes for the handful of
 * methods extension handlers typically touch first.
 */
export function buildSyntheticBim(spec: SyntheticFixtureSpec): SyntheticBim {
  const entities: SyntheticEntity[] = [];
  let nextId = 1;
  for (const [type, count] of Object.entries(spec.elements ?? {})) {
    for (let i = 0; i < count; i++) {
      entities.push({
        expressId: nextId++,
        type,
        props: { GlobalId: `${type}.${i.toString().padStart(4, '0')}` },
      });
    }
  }

  const bim: SyntheticBim = {
    schema: spec.schema ?? 'IFC4',
    isSynthetic: true,
    entities,
    query: {
      byType(type: string): SyntheticEntity[] {
        return entities.filter((e) => e.type === type);
      },
      count(type?: string): number {
        if (!type) return entities.length;
        return entities.filter((e) => e.type === type).length;
      },
    },
    ...(spec.extra ?? {}),
  };
  return bim;
}

/**
 * Build a `loadFixture` callback the test runner accepts. Given a
 * dictionary of named specs, returns a resolver that throws for
 * unknown names (so a typo in a manifest test's `fixture:` lands as
 * a clean per-test failure rather than a global crash).
 */
export function syntheticFixtureLoader(
  fixtures: Record<string, SyntheticFixtureSpec>,
): (name: string) => Promise<SyntheticBim> {
  return async (name: string): Promise<SyntheticBim> => {
    const spec = fixtures[name];
    if (!spec) throw new Error(`Unknown synthetic fixture "${name}".`);
    return buildSyntheticBim(spec);
  };
}

/** Canonical fixtures the spec references; bundles can ship their own. */
export const CANONICAL_FIXTURES: Record<string, SyntheticFixtureSpec> = {
  'residential-small': {
    id: 'residential-small',
    schema: 'IFC4',
    elements: {
      IfcWall: 12,
      IfcSlab: 4,
      IfcDoor: 6,
      IfcWindow: 8,
      IfcSpace: 5,
    },
  },
  'office-medium': {
    id: 'office-medium',
    schema: 'IFC4',
    elements: {
      IfcWall: 120,
      IfcSlab: 24,
      IfcColumn: 48,
      IfcBeam: 96,
      IfcDoor: 32,
      IfcWindow: 64,
      IfcSpace: 40,
    },
  },
  'empty-model': {
    id: 'empty-model',
    schema: 'IFC4',
    elements: {},
  },
};
