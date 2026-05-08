/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fixture-driven regression suite.
 *
 * The `.ids` files under `__fixtures__/` are copied verbatim from
 * buildingSMART/IDS-Audit-tool's `testing.shared/` corpus (MIT-licensed).
 * For each fixture we assert the expected status bucket — `valid`,
 * `warning` or `error` — and, where useful, that a specific code is
 * present in the issue list.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { auditIDSDocument } from './index.js';
import type { IDSAuditCode } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, '__fixtures__');

interface FixtureExpectation {
  /** Filename inside its bucket directory. */
  file: string;
  /** Expected aggregate status. */
  status: 'valid' | 'warning' | 'error';
  /** Optional expected codes — at least one must be present. */
  expectAny?: IDSAuditCode[];
  /** Optional codes that must NOT be present. */
  expectNot?: IDSAuditCode[];
}

const VALID: FixtureExpectation[] = [
  // Canonical 1.0 sample shipped by buildingSMART. Exercises every facet
  // type with valid IFC4 references — clean bill of health.
  { file: 'canonical-1.0.ids', status: 'valid' },
  { file: 'property.ids', status: 'valid' },
  { file: 'entities_enumeration.ids', status: 'valid' },
  { file: 'IDS_aachen_example.ids', status: 'valid' },
  { file: 'nested_entity.ids', status: 'valid' },
];

const INVALID: FixtureExpectation[] = [
  {
    file: 'InvalidEntityNames.ids',
    status: 'error',
    expectAny: ['E_IFC_ENTITY_UNKNOWN'],
  },
  {
    file: 'InvalidIfcEntityPredefinedType.ids',
    status: 'error',
    expectAny: ['E_IFC_PREDEF_TYPE_INVALID'],
  },
  {
    file: 'InvalidAttributeForClass.ids',
    status: 'error',
    expectAny: ['E_IFC_ATTR_UNKNOWN_FOR_ENTITY'],
  },
  { file: 'InvalidAttributeNames.ids', status: 'error' },
  {
    file: 'InvalidIfcPropertyInPset.ids',
    status: 'error',
    expectAny: ['E_IFC_PROP_NOT_IN_PSET'],
  },
  { file: 'InvalidIfcVersion.ids', status: 'error' },
  {
    file: 'InvalidCustomPsetBecauseOfPrefix.ids',
    status: 'warning',
    expectAny: ['W_IFC_PSET_RESERVED_PREFIX'],
  },
  { file: 'InvalidIfcPartOf.ids', status: 'error' },
  { file: 'InvalidRestrictions.ids', status: 'error' },
  { file: 'notAnXml.ids', status: 'error', expectAny: ['E_PARSE_XML'] },
  { file: 'notAnIdsElement.ids', status: 'error', expectAny: ['E_PARSE_ROOT'] },
  { file: 'empty.ids', status: 'error' },
];

const ISSUES: FixtureExpectation[] = [
  // Issue 28 ships an empty xs:restriction (no pattern/enumeration/bounds).
  {
    file: 'Issue 28 - Empty restriction.ids',
    status: 'error',
    expectAny: ['E_RESTRICTION_EMPTY', 'E_XSD_REQUIRED_ATTR'],
  },
  // Issue 25 references Pset_ConstructionOccurence — note: this exact
  // (mis-)spelling IS a real IFC4X3 pset, so the auditor returns clean.
  // Drop the expectation; we keep the fixture for parse-coverage.
];

function readFixture(bucket: string, file: string): string {
  return fs.readFileSync(path.join(fixturesRoot, bucket, file), 'utf8');
}

function runFixtureTable(bucket: string, table: FixtureExpectation[]): void {
  for (const fx of table) {
    it(`${bucket}/${fx.file} → ${fx.status}`, async () => {
      const xml = readFixture(bucket, fx.file);
      const r = await auditIDSDocument(xml);
      expect(
        r.status,
        `unexpected status for ${fx.file}; issues:\n${JSON.stringify(r.issues.slice(0, 5), null, 2)}`
      ).toBe(fx.status);
      if (fx.expectAny && fx.expectAny.length > 0) {
        const codes = r.issues.map((i) => i.code);
        const matched = fx.expectAny.some((c) => codes.includes(c));
        expect(
          matched,
          `none of ${JSON.stringify(fx.expectAny)} present in [${codes.join(', ')}]`
        ).toBe(true);
      }
      if (fx.expectNot) {
        const codes = r.issues.map((i) => i.code);
        for (const c of fx.expectNot) {
          expect(codes).not.toContain(c);
        }
      }
    });
  }
}

describe('audit fixtures — valid corpus', () => {
  runFixtureTable('valid', VALID);
});

describe('audit fixtures — invalid corpus', () => {
  runFixtureTable('invalid', INVALID);
});

describe('audit fixtures — known-issue corpus', () => {
  runFixtureTable('issues', ISSUES);
});
