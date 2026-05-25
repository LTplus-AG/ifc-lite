/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapability } from '../capability/parse.js';
import { CapabilityDeniedError, assertMethodCall, checkMethodCall } from './check.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

describe('checkMethodCall — pass', () => {
  it('passes when grants cover the method', () => {
    const r = checkMethodCall('query', 'byType', [p('model.read')]);
    expect(r.ok).toBe(true);
  });

  it('passes for unknown method (no requirement)', () => {
    // lens.presets returns metadata only — no capability needed.
    const r = checkMethodCall('lens', 'presets', []);
    expect(r.ok).toBe(true);
  });

  it('passes when a grant wildcard covers the requirement', () => {
    const r = checkMethodCall('mutate', 'setProperty', [p('model.mutate:*')]);
    expect(r.ok).toBe(true);
  });

  it('passes when one of multiple grants covers', () => {
    const r = checkMethodCall(
      'viewer',
      'colorize',
      [p('model.read'), p('viewer.colorize')],
    );
    expect(r.ok).toBe(true);
  });

  it('passes for export.csv with the specific grant', () => {
    const r = checkMethodCall('export', 'csv', [p('export.create:csv')]);
    expect(r.ok).toBe(true);
  });
});

describe('checkMethodCall — deny', () => {
  it('denies when no grant matches', () => {
    const r = checkMethodCall('viewer', 'colorize', [p('model.read')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.required).toContain('viewer.colorize');
  });

  it('denies viewer.fly without the corresponding capability', () => {
    const r = checkMethodCall('viewer', 'flyTo', [p('viewer.read')]);
    expect(r.ok).toBe(false);
  });

  it('denies model.mutate when only model.read is granted', () => {
    const r = checkMethodCall('mutate', 'setProperty', [p('model.read')]);
    expect(r.ok).toBe(false);
  });

  it('denies export.csv when wildcard scoped to a different format', () => {
    const r = checkMethodCall('export', 'csv', [p('export.create:glb')]);
    expect(r.ok).toBe(false);
  });

  it('denies when grants are empty', () => {
    const r = checkMethodCall('viewer', 'colorize', []);
    expect(r.ok).toBe(false);
  });
});

describe('assertMethodCall', () => {
  it('does not throw on pass', () => {
    expect(() => assertMethodCall('query', 'byType', [p('model.read')])).not.toThrow();
  });

  it('throws CapabilityDeniedError on deny', () => {
    expect(() => assertMethodCall('viewer', 'colorize', [p('model.read')]))
      .toThrowError(CapabilityDeniedError);
  });

  it('error carries the call site and capability lists', () => {
    try {
      assertMethodCall('viewer', 'colorize', [p('model.read')]);
    } catch (err) {
      if (!(err instanceof CapabilityDeniedError)) throw err;
      expect(err.call).toBe('bim.viewer.colorize');
      expect(err.requiredCapabilities).toContain('viewer.colorize');
      expect(err.grantedCapabilities).toContain('model.read');
      return;
    }
    throw new Error('expected assertMethodCall to throw');
  });
});
