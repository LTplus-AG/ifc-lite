/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS test suites (07-interop-versioning-collab.md §5, ADR-013): "unit
 * tests for information requirements". A specification carries test
 * cases, each an IFC fixture plus the verdict the specification must give
 * on it. Suites live in the sidecar (`meta.tests[specId]`) and change only
 * through `meta.test.*` ops.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import type { Uuid } from '../uuid.js';

/** What a specification must report on a fixture. */
export type TestExpectation = 'pass' | 'fail' | 'notApplicable';

/**
 * How a synthetic fixture is (re)generated from the specification
 * (`@ifc-lite/ids-testgen`). The fixture follows the specification: when
 * the specification changes, so does the regenerated fixture.
 */
export interface FixtureRecipe {
  generator: 'ids-testgen/1';
  ifcVersion: IFCVersion;
  variant:
    | { kind: 'pass' }
    /** Violates exactly this requirement facet. */
    | { kind: 'fail'; requirementId: Uuid }
    /** Violates the first applicability facet. */
    | { kind: 'notApplicable' };
}

export type TestFixture =
  | { kind: 'synthetic'; recipe: FixtureRecipe }
  /** Extracted from a real model ("pin element as test"); `ifcRef` names the stored subset. */
  | { kind: 'snapshot'; ifcRef: string; entityRefs: string[] }
  /** Any IFC file, e.g. `fixtures/door-ok.ifc` inside an `.idsz` bundle. */
  | { kind: 'file'; path: string };

export interface TestCase {
  id: Uuid;
  name: string;
  fixture: TestFixture;
  expect: TestExpectation;
  /** For `fail`: the requirement facets that must fail (exactly these). */
  expectFailureOn?: Uuid[];
}

export interface TestSuite {
  specId: Uuid;
  cases: TestCase[];
}
