/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as walk from 'acorn-walk';
import { inferCapabilities, type InferenceResult } from './capability.js';

describe('inferCapabilities — read-only patterns', () => {
  it('detects model.read for bim.query usage', () => {
    const r = inferCapabilities('const w = bim.query.byType("IfcWall");');
    expect(r.capabilities).toContain('model.read');
    expect(r.parseErrors).toEqual([]);
  });

  it('detects viewer.read for bim.viewer.getSelection', () => {
    const r = inferCapabilities('const s = await bim.viewer.getSelection();');
    expect(r.capabilities).toContain('viewer.read');
  });

  it('returns no capabilities for an empty script', () => {
    expect(inferCapabilities('').capabilities).toEqual([]);
  });

  it('returns no capabilities for a script that does not touch bim', () => {
    const r = inferCapabilities('const x = 1 + 2; console.log(x);');
    expect(r.capabilities).toEqual([]);
  });
});

describe('inferCapabilities — viewer methods', () => {
  it('flyTo → viewer.fly', () => {
    expect(inferCapabilities('bim.viewer.flyTo({});').capabilities).toContain('viewer.fly');
  });

  it('colorize → viewer.colorize', () => {
    expect(inferCapabilities('bim.viewer.colorize({});').capabilities).toContain('viewer.colorize');
  });

  it('isolate → viewer.isolate', () => {
    expect(inferCapabilities('bim.viewer.isolate(ids);').capabilities).toContain('viewer.isolate');
  });

  it('setSection → viewer.section', () => {
    expect(inferCapabilities('bim.viewer.setSection({});').capabilities).toContain('viewer.section');
  });
});

describe('inferCapabilities — mutation patterns', () => {
  it('bim.mutate.* defaults to model.mutate:* (broad)', () => {
    const r = inferCapabilities('bim.mutate.setProperty(id, "Pset_X", "F", 1);');
    expect(r.capabilities).toContain('model.mutate:*');
  });

  it('bim.mutate.delete → model.delete', () => {
    const r = inferCapabilities('bim.mutate.delete(id);');
    expect(r.capabilities).toContain('model.delete');
  });

  it('bim.create.* → model.create', () => {
    expect(inferCapabilities('bim.create.project({});').capabilities).toContain('model.create');
  });
});

describe('inferCapabilities — export', () => {
  it('bim.export.csv → export.create:csv', () => {
    expect(inferCapabilities('bim.export.csv(rows);').capabilities).toContain('export.create:csv');
  });

  it('bim.export.json → export.create:json', () => {
    expect(inferCapabilities('bim.export.json(data);').capabilities).toContain('export.create:json');
  });

  it('bim.export.glb → export.create:glb', () => {
    expect(inferCapabilities('bim.export.glb({});').capabilities).toContain('export.create:glb');
  });

  it('unknown export method falls back to export.create:*', () => {
    expect(inferCapabilities('bim.export.somethingWeird(x);').capabilities).toContain('export.create:*');
  });
});

describe('inferCapabilities — combinatorial', () => {
  it('combines multiple capabilities from a real-looking script', () => {
    const script = `
      const walls = bim.query.byType('IfcWall');
      bim.viewer.colorize({ ids: walls.map((w) => w.globalId), color: [1,0,0,1] });
      bim.viewer.flyTo({ ids: walls });
      await bim.export.csv(walls);
    `;
    const r = inferCapabilities(script);
    expect(r.capabilities).toEqual(expect.arrayContaining([
      'model.read',
      'viewer.colorize',
      'viewer.fly',
      'export.create:csv',
    ]));
  });

  it('deduplicates observations by call site', () => {
    const script = `
      bim.query.byType('IfcWall');
      bim.query.byType('IfcDoor');
      bim.query.byType('IfcWindow');
    `;
    const r = inferCapabilities(script);
    expect(r.observations.filter((o) => o.call === 'bim.query.byType')).toHaveLength(1);
  });

  it('returns sorted capability list', () => {
    const script = `
      bim.viewer.flyTo({});
      bim.query.byType('x');
      bim.export.csv([]);
    `;
    const r = inferCapabilities(script);
    expect(r.capabilities).toEqual([...r.capabilities].sort());
  });
});

describe('inferCapabilities — unknown calls', () => {
  it('marks unknown namespaces in observations', () => {
    const r = inferCapabilities('bim.totallyMadeUp.thing();');
    const obs = r.observations.find((o) => o.call.startsWith('bim.totallyMadeUp'));
    expect(obs?.unknown).toBe(true);
  });

  it('ignores non-bim references', () => {
    const r = inferCapabilities(`
      const foo = window.location.href;
      const bar = console.log;
    `);
    expect(r.capabilities).toEqual([]);
    expect(r.observations).toEqual([]);
  });
});

describe('inferCapabilities — unrecognised methods in a differentiated namespace', () => {
  // `mutate` has an explicit `methods` map in the catalogue (only
  // `delete` is overridden today), so it already differentiates
  // capability by method. `setProperty` is a real bridge method
  // (packages/sandbox/src/bridge-mutate.ts) that the map does not
  // classify — before the fix this silently fell through to the
  // namespace default with `unknown: false` and no warning, exactly
  // the "reviewer never told" gap described in capability.ts's design
  // rule #3. Chosen because it is untouched by PR #3487 (which only
  // adds overrides to `viewer`/`store`), so it stays a valid example
  // whether or not that PR has merged.
  it('(i) known namespace, unrecognised method → flagged unknown, capability still granted', () => {
    const r = inferCapabilities('bim.mutate.setProperty(id, "Pset_X", "F", 1);');
    const obs = r.observations.find((o) => o.call === 'bim.mutate.setProperty');
    expect(obs?.unknown).toBe(true);
    // Never under-grant: the namespace default is still returned.
    expect(obs?.capabilities).toEqual(['model.mutate:*']);
  });

  it('(ii) known namespace, recognised method (explicit override) → not flagged', () => {
    const r = inferCapabilities('bim.mutate.delete(id);');
    const obs = r.observations.find((o) => o.call === 'bim.mutate.delete');
    expect(obs?.unknown).toBe(false);
  });

  it('(ii) known namespace, flat namespace with no `methods` map at all → not flagged', () => {
    // `query` has no per-method differentiation in the catalogue, so an
    // unlisted method is the intended fallback, not a gap.
    const r = inferCapabilities('bim.query.byType("IfcWall");');
    const obs = r.observations.find((o) => o.call === 'bim.query.byType');
    expect(obs?.unknown).toBe(false);
  });

  it('(iii) unknown namespace → still flagged (regression guard)', () => {
    const r = inferCapabilities('bim.totallyMadeUp.thing();');
    const obs = r.observations.find((o) => o.call === 'bim.totallyMadeUp.thing');
    expect(obs?.unknown).toBe(true);
  });
});

describe('inferCapabilities — parse errors', () => {
  it('reports parse errors on syntactically invalid input', () => {
    const r = inferCapabilities('this is not js');
    expect(r.parseErrors.length).toBeGreaterThan(0);
    expect(r.capabilities).toEqual([]);
  });

  it('accepts top-level await', () => {
    const r = inferCapabilities('const x = await bim.viewer.getSelection();');
    expect(r.parseErrors).toEqual([]);
    expect(r.capabilities).toContain('viewer.read');
  });

  it('ignores computed member access (no over-grant guess)', () => {
    // bim['viewer'].colorize — we deliberately do not chase computed
    // access. Tests document the contract.
    const r = inferCapabilities('bim["viewer"].colorize({});');
    expect(r.capabilities).toEqual([]);
  });
});

describe('inferCapabilities — non-string inputs', () => {
  it('returns a parse error for non-string input', () => {
    const r = inferCapabilities(123 as unknown as string);
    expect(r.parseErrors.length).toBeGreaterThan(0);
  });
});

describe('inferCapabilities — deeply nested scripts fail closed', () => {
  /** `levels` nested `if (1) { … }` blocks around `inner`. */
  function nestIf(levels: number, inner: string): string {
    return 'if(1){'.repeat(levels) + inner + '}'.repeat(levels);
  }

  it('still infers from a deep-but-legal script', () => {
    // 400 source levels is ~800 AST levels — under the bound.
    const r = inferCapabilities(nestIf(400, 'bim.viewer.colorize({});'));
    expect(r.parseErrors).toEqual([]);
    expect(r.capabilities.length).toBeGreaterThan(0);
    expect(r.observations.map((o) => o.call)).toContain('bim.viewer.colorize');
  });

  it('reports a parse error instead of throwing past the bound', () => {
    // Before the bound this threw `RangeError: Maximum call stack size
    // exceeded` out of acorn-walk.
    let r!: InferenceResult;
    expect(() => {
      r = inferCapabilities(nestIf(800, 'bim.viewer.colorize({});'));
    }).not.toThrow();
    expect(r.parseErrors.some((e) => /nested more than \d+ AST levels/.test(e.message))).toBe(true);
  });

  it('never reports a partial capability set for a too-deep script', () => {
    // Fail-closed is the whole point. `migrateSavedScripts` skips on a
    // parse error but treats an empty capability set as "grant
    // model.read and migrate anyway", and PromoteToolDialog renders an
    // empty set as "no bim.* calls detected". A truncated walk must
    // therefore surface as a parse error, not as capabilities.
    const r = inferCapabilities(nestIf(800, 'bim.viewer.colorize({});'));
    expect(r.parseErrors.length).toBeGreaterThan(0);
    expect(r.capabilities).toEqual([]);
    expect(r.observations).toEqual([]);
  });

  it('reports the depth error even when bim.* calls sit above the cut-off', () => {
    // The capabilities found before the walk stopped are a floor, not
    // the answer — deeper calls may need more. Returning just the
    // shallow ones would under-grant silently.
    const r = inferCapabilities(`bim.viewer.colorize({});\n${nestIf(800, 'bim.model.write();')}`);
    expect(r.parseErrors.some((e) => /nested more than \d+ AST levels/.test(e.message))).toBe(true);
    expect(r.capabilities).toEqual([]);
  });

  it('gives the same verdict however much stack the caller has left', () => {
    const source = nestIf(800, 'bim.viewer.colorize({});');
    const shallow = inferCapabilities(source);
    const recurse = (n: number): InferenceResult =>
      n === 0 ? inferCapabilities(source) : recurse(n - 1);
    const deep = recurse(2000);
    expect(deep.capabilities).toEqual(shallow.capabilities);
    expect(deep.parseErrors.map((e) => e.message)).toEqual(
      shallow.parseErrors.map((e) => e.message),
    );
  });
});

describe('inferCapabilities — a subtree the walker cannot descend', () => {
  /** See `validate/code.test.ts`: simulates an acorn/acorn-walk skew. */
  function withoutBase<T>(type: string, run: () => T): T {
    const base = walk.base as unknown as Record<string, unknown>;
    const saved = base[type];
    expect(saved).toBeTypeOf('function');
    delete base[type];
    try {
      return run();
    } finally {
      base[type] = saved;
    }
  }

  it('reports a parse error rather than an under-counted capability set', () => {
    const source = 'bim.viewer.colorize({});\ntry { bim.model.write(); } catch (e) {}';
    // Unmodified, both calls are seen.
    expect(inferCapabilities(source).capabilities.length).toBeGreaterThan(1);

    const r = withoutBase('TryStatement', () => inferCapabilities(source));
    expect(r.parseErrors.some((e) => /cannot traverse/.test(e.message))).toBe(true);
    expect(r.parseErrors.some((e) => /TryStatement/.test(e.message))).toBe(true);
    // Fail closed: the floor it did see is discarded, not published.
    expect(r.capabilities).toEqual([]);
    expect(r.observations).toEqual([]);
  });
});
