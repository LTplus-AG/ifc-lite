/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { groupDiagnostics, renderDiagnostics, summariseDiagnostics } from './diagnostics.js';

const errors = [
  { path: 'manifest.id', code: 'invalid_id' as const, message: 'bad id', hint: 'use reverse-DNS' },
  { path: 'manifest.version', code: 'invalid_semver' as const, message: 'bad semver' },
  { path: 'src/commands/run.js[3:2]', code: 'invalid_value' as const, message: 'globalThis used' },
];

describe('groupDiagnostics', () => {
  it('groups by leading path segment', () => {
    const groups = groupDiagnostics(errors);
    const scopes = groups.map((g) => g.scope).sort();
    // `manifest.id` and `manifest.version` share the "manifest" scope;
    // `src/commands/run.js[3:2]` splits on `[` to "src/commands/run.js".
    expect(scopes).toEqual(['manifest', 'src/commands/run.js']);
  });
});

describe('renderDiagnostics', () => {
  it('produces a markdown block', () => {
    const text = renderDiagnostics(errors);
    expect(text).toContain('manifest');
    expect(text).toContain('bad id');
    expect(text).toContain('hint: use reverse-DNS');
  });

  it('returns no-issues placeholder for empty input', () => {
    expect(renderDiagnostics([])).toContain('No diagnostics');
  });
});

describe('summariseDiagnostics', () => {
  it('single-issue case', () => {
    expect(summariseDiagnostics([errors[0]])).toContain('bad id');
  });

  it('multi-scope summary', () => {
    expect(summariseDiagnostics(errors)).toMatch(/issues across \d+ scopes/);
  });

  it('empty case', () => {
    expect(summariseDiagnostics([])).toBe('No issues.');
  });
});
