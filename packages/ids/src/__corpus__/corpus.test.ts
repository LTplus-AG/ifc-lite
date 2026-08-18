/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * buildingSMART's official IDS conformance corpus, run against this package
 * (github.com/LTplus-AG/ifc-lite/issues/2747).
 *
 * The 318 IDS+IFC pairs under `buildingsmart-ids/` were vendored in #1685 and
 * then referenced by nothing. Their README asserted that "the `corpus.test.ts`
 * test runs the entire corpus"; `git log --all --diff-filter=A` shows no such
 * file has ever existed in this repository, and four source files describe a
 * "corpus-parity harness" consuming the IDS bridge that did not exist either.
 * Five places said the corpus was wired in, which is the likeliest reason
 * nobody noticed that it was not. This file is that harness.
 *
 * ## Why an official corpus, rather than more hand-written fixtures
 *
 * A spec-validation library tested only against models it should accept cannot
 * detect an inverted predicate. #2746 found `matchBounds` had its `xs:length` /
 * `xs:minLength` / `xs:maxLength` inequalities unpinned: inverting all three
 * left the whole package green, because no fixture anywhere built a bounds
 * constraint with those fields. The corpus contains the fixtures for exactly
 * that (`restriction/*max_and_min_length*`), in both directions, and had done
 * all along.
 *
 * ## The three prefixes route to two different entry points
 *
 * `pass-` and `fail-` are questions about a MODEL: the IDS is well-formed and
 * the answer is whether the IFC satisfies it, which is `validateIDS`.
 * `invalid-` is a question about the IDS DOCUMENT: the file is not conforming
 * IDS, so the validator is the wrong judge of it and `auditIDSDocument` is the
 * right one. Routing every prefix through the validator was measured first and
 * reports `fail` for all 27 `invalid-` cases, which is not wrong so much as an
 * answer to a different question.
 *
 * Assertions are PER SPECIFICATION, not per file. A file-level aggregate ("did
 * anything fail?") can be green while individual specifications disagree in
 * compensating directions, which would make this corpus test one more thing
 * that cannot observe what it claims. Every corpus file currently holds exactly
 * one specification and `EXPECTED_SPECS_PER_FILE` pins that, so a future corpus
 * update introducing a multi-specification case fails here loudly instead of
 * being silently averaged.
 *
 * ## Licence
 *
 * The corpus is (c) buildingSMART International Ltd under CC BY-ND 4.0 (see
 * `buildingsmart-ids/UPSTREAM_LICENSE`). NoDerivatives: this harness only ever
 * READS the vendored files. Nothing here rewrites a fixture, and a test needing
 * a variant must build it in memory rather than committing a modified copy.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { auditIDSDocument } from '../audit/index.js';
import { createDataAccessor } from '../bridge/index.js';

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'buildingsmart-ids');

/**
 * What the corpus holds today. These are guards, not trivia: a harness whose
 * file discovery quietly breaks finds zero pairs, asserts nothing, and reports
 * exactly the same green as one that checked all 318. Empty input must not
 * score perfect.
 */
const EXPECTED = { pass: 179, fail: 112, invalid: 27 } as const;
const EXPECTED_SPECS_PER_FILE = 1;

type Expectation = keyof typeof EXPECTED;

interface CorpusCase {
  /** `restriction/pass-a_bound_can_be_inclusive_1_4`, for the test name. */
  id: string;
  expectation: Expectation;
  idsPath: string;
  ifcPath: string;
}

function collect(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.ids')) continue;
      const base = name.slice(0, -4);
      const expectation: Expectation | null = base.startsWith('pass-')
        ? 'pass'
        : base.startsWith('fail-')
          ? 'fail'
          : base.startsWith('invalid-')
            ? 'invalid'
            : null;
      // An unknown prefix means the corpus grew a convention this harness does
      // not encode. Skipping it silently is how a case stops being run.
      expect(expectation, `unrecognised corpus prefix: ${name}`).not.toBeNull();
      cases.push({
        id: `${dir.slice(CORPUS_ROOT.length + 1)}/${base}`,
        expectation: expectation as Expectation,
        idsPath: path,
        ifcPath: join(dir, `${base}.ifc`),
      });
    }
  };
  walk(CORPUS_ROOT);
  return cases;
}

const CASES = collect();

/** Parse the paired IFC and project it through the shared bridge. */
async function accessorFor(ifcPath: string) {
  const bytes = readFileSync(ifcPath);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return { accessor: createDataAccessor(store), store };
}

describe('buildingSMART IDS conformance corpus', () => {
  it('discovers the whole corpus', () => {
    // First, because every assertion below is vacuous if this is wrong.
    const counted = { pass: 0, fail: 0, invalid: 0 };
    for (const c of CASES) counted[c.expectation]++;
    expect(counted).toEqual(EXPECTED);
  });

  it('pairs every IDS with its IFC', () => {
    const missing = CASES.filter((c) => c.expectation !== 'invalid')
      .filter((c) => !statSync(c.ifcPath, { throwIfNoEntry: false }));
    expect(missing.map((c) => c.id)).toEqual([]);
  });

  describe('pass- and fail-: does the MODEL satisfy a well-formed IDS', () => {
    for (const c of CASES.filter((x) => x.expectation !== 'invalid')) {
      it(`${c.id} -> ${c.expectation}`, async () => {
        const document = parseIDS(readFileSync(c.idsPath, 'utf8'));
        expect(document.specifications).toHaveLength(EXPECTED_SPECS_PER_FILE);
        const { accessor, store } = await accessorFor(c.ifcPath);
        const report = await validateIDS(document, accessor, {
          modelId: c.id,
          schemaVersion: String(store.schemaVersion ?? 'IFC4'),
          entityCount: 0,
        });
        // Per specification: the single result's own status, not "did anything
        // in the file fail".
        expect(report.specificationResults.map((r) => r.status)).toEqual([c.expectation]);
      });
    }
  });

/**
 * `invalid-` cases the audit does not detect yet. Each is an IDS-level validity
 * rule this package has not implemented (mostly the typed-value spellings: a
 * boolean that must be lowercase, an integer that must not carry a decimal, an
 * entity name that must be uppercase).
 *
 * The list may only SHRINK. A case that starts being detected FAILS here until
 * it is removed, so the list cannot quietly go stale and re-hide a regression
 * the way an ignore-list would. Being on it is a claim that gets re-tested on
 * every run, not an exemption from testing.
 *
 * These are not silently passing: `validateIDS` reports `fail` for all 21,
 * because the model does not satisfy a specification the IDS should never have
 * been able to express. That is a defensible answer to a different question,
 * which is why they are audited here rather than validated.
 */
const AUDIT_UNDETECTED = new Set([
  'attribute/invalid-booleans_must_be_specified_as_lowercase_strings_2_3',
  'attribute/invalid-integers_cannot_be_expressed_as_floating_point_numbers_2_2',
  'attribute/invalid-only_specifically_formatted_numbers_are_allowed_1_4',
  'attribute/invalid-only_specifically_formatted_numbers_are_allowed_2_4',
  'attribute/invalid-specifying_a_float_when_the_value_is_an_integer_is_invalid',
  'attribute/invalid-value_checks_always_fail_for_lists',
  'entity/invalid-an_entity_not_matching_the_specified_class_should_fail',
  'entity/invalid-entities_can_be_specified_as_a_xsd_regex_pattern_1_2',
  'entity/invalid-entities_can_be_specified_as_an_enumeration_3_3',
  'entity/invalid-entities_must_be_specified_as_uppercase_strings',
  'entity/invalid-subclasses_are_not_considered_as_matching',
  'ids/invalid-prohibited_specifications_invalid_if_requirements_are_specified',
  'partof/invalid-a_group_predefined_type_must_match_exactly_1_2',
  'property/invalid-booleans_must_be_specified_as_lowercase_strings_3_3',
  'property/invalid-integer_values_are_checked_using_type_casting_4_4',
  'property/invalid-integer_values_cannot_be_stored_with_decimal_2_4',
  'property/invalid-integer_values_cannot_be_stored_with_decimal_3_4',
  'property/invalid-only_specifically_formatted_numbers_are_allowed_1_4',
  'property/invalid-only_specifically_formatted_numbers_are_allowed_2_4',
  'restriction/invalid-patterns_always_fail_on_any_number',
  'restriction/invalid-patterns_only_work_on_strings_and_nothing_else',
]);

/**
 * How many `invalid-` cases the audit DOES catch, measured at runtime.
 *
 * Recorded as a number rather than derived from the set above, because a count
 * taken from the allowlist it is meant to bound is circular and always passes.
 * This one moves if detection regresses OR if the allowlist grows, and both
 * should be a deliberate, visible diff.
 */
const AUDIT_DETECTS = 6;

  describe('invalid-: is the IDS DOCUMENT itself non-conforming', () => {
    it('every allowlisted case is a real corpus file', () => {
      // A typo in the list above would otherwise silently exempt nothing while
      // looking like it exempts something.
      const ids = new Set(CASES.map((c) => c.id));
      expect([...AUDIT_UNDETECTED].filter((id) => !ids.has(id))).toEqual([]);
    });

    it(`the audit detects ${AUDIT_DETECTS} of them today`, async () => {
      let detected = 0;
      for (const c of CASES.filter((x) => x.expectation === 'invalid')) {
        const report = await auditIDSDocument(readFileSync(c.idsPath, 'utf8'));
        if (report.issues.length > 0) detected++;
      }
      expect(detected).toBe(AUDIT_DETECTS);
    });

    for (const c of CASES.filter((x) => x.expectation === 'invalid')) {
      const known = AUDIT_UNDETECTED.has(c.id);
      it(`${c.id} ${known ? '(not detected yet)' : 'is rejected by the audit'}`, async () => {
        const report = await auditIDSDocument(readFileSync(c.idsPath, 'utf8'));
        if (known) {
          expect(
            report.issues.length,
            `${c.id} is now detected: delete it from AUDIT_UNDETECTED`,
          ).toBe(0);
          return;
        }
        // At least one issue, and the document is not reported as clean. Both,
        // because `status` and `issues` are separately derived and a harness
        // asserting only one of them would not notice the other going quiet.
        expect(report.issues.length).toBeGreaterThan(0);
        expect(report.status).not.toBe('valid');
      });
    }
  });
});
