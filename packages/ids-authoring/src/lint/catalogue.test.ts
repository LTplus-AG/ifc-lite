/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Catalogue-wide invariants: codes, metadata, assumption policy. */

import { describe, expect, it } from 'vitest';
import { LINT_RULES } from './rules/index.js';

/** RAID assumptions that have been verified (see worklog/P-04.md). */
const VERIFIED = new Set(['A-03', 'A-04']);

describe('lint catalogue', () => {
  it('ships at least 25 static rules (beta target) with unique, well-formed codes', () => {
    expect(LINT_RULES.filter((r) => r.kind === 'static').length).toBeGreaterThanOrEqual(25);
    const codes = LINT_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of LINT_RULES) expect(r.code).toMatch(new RegExp(`^IDSL-${r.area}-\\d{3}$`));
  });

  it('documents every rule', () => {
    for (const r of LINT_RULES) {
      expect(r.title.length, r.code).toBeGreaterThan(10);
      expect(r.rationale.length, r.code).toBeGreaterThan(80);
      expect(r.example, r.code).toBeTruthy();
    }
  });

  it('ships a rule above info only when every assumption it relies on is verified', () => {
    for (const r of LINT_RULES) {
      for (const a of r.assumptions ?? []) {
        expect(a.verified.length, `${r.code} ${a.id}`).toBeGreaterThan(40);
        if (r.defaultSeverity !== 'info') expect(VERIFIED.has(a.id), `${r.code} relies on unverified ${a.id}`).toBe(true);
      }
    }
  });
});
