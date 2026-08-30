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

  // `colorizeAll`, `resetColors`, and `resetVisibility` are real bridge
  // methods (packages/sandbox/src/bridge-viewer.ts) that mutate viewer
  // state exactly like `colorize`/`isolate` do. The catalogue's module doc
  // says it is kept in sync with that schema, and design rule #2 above
  // ("Never under-grant") forbids a mutating call resolving to the
  // read-only default.
  it('colorizeAll → viewer.colorize (not the viewer.read default)', () => {
    expect(inferCapabilities('bim.viewer.colorizeAll([]);').capabilities).toContain('viewer.colorize');
  });

  it('resetColors → viewer.colorize (not the viewer.read default)', () => {
    expect(inferCapabilities('bim.viewer.resetColors();').capabilities).toContain('viewer.colorize');
  });

  it('resetVisibility → viewer.isolate (not the viewer.read default)', () => {
    expect(inferCapabilities('bim.viewer.resetVisibility();').capabilities).toContain('viewer.isolate');
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

  // `bim.store.*` (packages/sandbox/src/bridge-store.ts) is document-level
  // edits, not reads — the namespace has no read-only methods at all. The
  // catalogue's own default for the namespace is `model.read`, which is
  // safe only for an untargeted `bim.store` reference; every real method
  // must have an explicit override or it silently under-grants.
  it('bim.store.addWall → model.create', () => {
    const r = inferCapabilities('bim.store.addWall("m1", 5, {});');
    expect(r.capabilities).toContain('model.create');
  });

  it('bim.store.removeEntity → model.delete', () => {
    const r = inferCapabilities('bim.store.removeEntity(ref);');
    expect(r.capabilities).toContain('model.delete');
  });

  it('bim.store.setPositionalAttribute → model.mutate:*', () => {
    const r = inferCapabilities('bim.store.setPositionalAttribute(ref, 3, 42);');
    expect(r.capabilities).toContain('model.mutate:*');
  });

  it('bim.model.loadIfc → model.create (loads a new document, not a read)', () => {
    const r = inferCapabilities('bim.model.loadIfc(content, "tower.ifc");');
    const call = r.observations.find((o) => o.call === 'bim.model.loadIfc');
    expect(call?.capabilities).toEqual(['model.create']);
  });

  it('bim.model.list still infers model.read (regression guard)', () => {
    const r = inferCapabilities('const models = bim.model.list();');
    const call = r.observations.find((o) => o.call === 'bim.model.list');
    expect(call?.capabilities).toEqual(['model.read']);
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

describe('inferCapabilities — unclassified methods in a differentiated namespace', () => {
  // `mutate` differentiates capability by method, so its `methods` map is
  // the complete classification set for that namespace. `batch` is not in
  // it and is not a bridge method either — the SDK has one but the bridge
  // deliberately omits it, because QuickJS cannot marshal the callback
  // (packages/sandbox/src/bridge-mutate.ts). A script calling it is
  // exactly the case the warning is for: before the fix `mutate` was a
  // known namespace, so this reported `unknown: false` and the reviewer
  // was told nothing.
  it('(i) known namespace, unclassified method → flagged unknown, capability still granted', () => {
    const r = inferCapabilities('bim.mutate.batch(() => {});');
    const obs = r.observations.find((o) => o.call === 'bim.mutate.batch');
    expect(obs?.unknown).toBe(true);
    // Never under-grant: the namespace default is still returned.
    expect(obs?.capabilities).toEqual(['model.mutate:*']);
  });

  // The other half of the rule, and the one that keeps this a tripwire
  // instead of noise: a differentiated namespace lists every real bridge
  // method, including the ones whose answer IS the namespace default. Both
  // of these are real methods (bridge-export.ts, bridge-mutate.ts) whose
  // correct grant is the namespace default, so a reviewer has nothing to
  // investigate and must not be told otherwise.
  it('(ii) real method classified at the namespace default → not flagged', () => {
    const r = inferCapabilities('bim.export.download("a.txt", "hello");');
    const obs = r.observations.find((o) => o.call === 'bim.export.download');
    expect(obs?.unknown).toBe(false);
    expect(obs?.capabilities).toEqual(['export.create:*']);
  });

  it('(ii) real method classified at the wildcard mutate default → not flagged', () => {
    const r = inferCapabilities('bim.mutate.setProperty(id, "Pset_X", "F", 1);');
    const obs = r.observations.find((o) => o.call === 'bim.mutate.setProperty');
    expect(obs?.unknown).toBe(false);
    expect(obs?.capabilities).toEqual(['model.mutate:*']);
  });

  it('(ii) real method whose default grant is a known, deliberate limitation → not flagged', () => {
    // `viewer.select` writes selection state and resolves to `viewer.read`
    // because the capability catalogue has no scope for it. That is a
    // recorded decision, not a call nobody classified, so the reviewer
    // gets no warning for it.
    const r = inferCapabilities('bim.viewer.select(ids);');
    const obs = r.observations.find((o) => o.call === 'bim.viewer.select');
    expect(obs?.unknown).toBe(false);
    expect(obs?.capabilities).toEqual(['viewer.read']);
  });

  it('(ii) known namespace, method with a non-default entry → not flagged', () => {
    const r = inferCapabilities('bim.viewer.colorize({});');
    const obs = r.observations.find((o) => o.call === 'bim.viewer.colorize');
    expect(obs?.unknown).toBe(false);
  });

  it('(ii) flat namespace with no `methods` map at all → not flagged', () => {
    // `query` has no per-method differentiation in the catalogue, so an
    // unlisted method is the intended fallback, not a gap.
    const r = inferCapabilities('bim.query.byType("IfcWall");');
    const obs = r.observations.find((o) => o.call === 'bim.query.byType');
    expect(obs?.unknown).toBe(false);
  });

  it('(iii) unknown namespace → still flagged, and grants nothing', () => {
    const r = inferCapabilities('bim.totallyMadeUp.thing();');
    const obs = r.observations.find((o) => o.call === 'bim.totallyMadeUp.thing');
    expect(obs?.unknown).toBe(true);
    // There is no namespace default to fall back on here, so unlike an
    // unclassified method this is not an over-grant at all.
    expect(obs?.capabilities).toEqual([]);
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
