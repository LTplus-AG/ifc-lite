/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { inferCapabilities } from './capability.js';

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
