/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validatePlan } from './plan.js';

describe('validatePlan — happy', () => {
  it('accepts a minimal plan', () => {
    const r = validatePlan({
      summary: 'Add a fire-rating panel',
      rationale: 'Surface fire ratings of selected walls.',
      contributions: [{ kind: 'dock', label: 'Fire Rating panel', id: 'ext.fire.panel' }],
      capabilities: ['model.read', 'viewer.read'],
      triggers: ['onSelectionChange'],
      widgets: [{ path: 'widgets/fire.json', description: 'Fire rating dock panel' }],
      tests: [{ name: 'panel renders', fixture: 'small-res', assertionSummary: 'KeyValueGrid has wallName' }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('validatePlan — errors', () => {
  it('rejects non-object', () => {
    expect(validatePlan('nope').ok).toBe(false);
  });

  it('rejects missing summary', () => {
    expect(validatePlan({ rationale: 'x', contributions: [], capabilities: [], triggers: [], widgets: [], tests: [] }).ok).toBe(false);
  });

  it('rejects unknown contribution kind', () => {
    const r = validatePlan({
      summary: 's',
      rationale: 'r',
      contributions: [{ kind: 'magic', label: 'X' }],
      capabilities: [],
      triggers: [],
      widgets: [],
      tests: [],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed test', () => {
    const r = validatePlan({
      summary: 's',
      rationale: 'r',
      contributions: [],
      capabilities: [],
      triggers: [],
      widgets: [],
      tests: [{ name: 't' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-string capability', () => {
    const r = validatePlan({
      summary: 's',
      rationale: 'r',
      contributions: [],
      capabilities: [42],
      triggers: [],
      widgets: [],
      tests: [],
    });
    expect(r.ok).toBe(false);
  });
});
