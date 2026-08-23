/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { migrateSavedScripts } from './migrate-scripts.js';

describe('migrateSavedScripts', () => {
  it('produces a flavor + one extension per script', () => {
    const r = migrateSavedScripts([
      { id: 'count-walls', name: 'Count Walls', code: 'bim.query.byType("IfcWall");' },
      { id: 'export-csv', name: 'Export CSV', code: 'bim.export.csv(rows);' },
    ]);
    expect(r.flavor.extensions).toHaveLength(2);
    expect(r.extensions).toHaveLength(2);
  });

  it('infers capabilities per script', () => {
    const r = migrateSavedScripts([
      { id: 'fly', name: 'Fly', code: 'bim.viewer.flyTo({});' },
    ]);
    expect(r.extensions[0].capabilities).toContain('viewer.fly');
  });

  it('falls back to model.read when no bim references are detected', () => {
    const r = migrateSavedScripts([
      { id: 'log', name: 'Log only', code: 'console.log("hi");' },
    ]);
    expect(r.extensions[0].capabilities).toEqual(['model.read']);
  });

  it('skips scripts that do not parse', () => {
    const r = migrateSavedScripts([
      { id: 'broken', name: 'Broken', code: 'function ( {' },
    ]);
    expect(r.extensions).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('skips a script too deeply nested to infer capabilities from', () => {
    // Capability inference stops at its AST depth bound and reports the
    // stop as a parse error. That must land in `skipped` — the
    // alternative, an empty capability set, silently falls through to
    // the `model.read` fallback above and migrates an uninspected
    // script.
    const code = `${'if(1){'.repeat(800)}bim.model.write();${'}'.repeat(800)}`;
    const r = migrateSavedScripts([{ id: 'deep', name: 'Deep', code }]);
    expect(r.extensions).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/nested more than \d+ AST levels/);
  });

  it('produces a slug-stable extension id', () => {
    const r = migrateSavedScripts([
      { id: 'Count Walls!', name: 'Count Walls!', code: 'bim.query.byType("IfcWall");' },
    ]);
    expect(r.extensions[0].id).toMatch(/^com\.local\.my-scripts\.count-walls/);
  });

  it('respects an overridden namespace', () => {
    const r = migrateSavedScripts(
      [{ id: 'x', name: 'X', code: 'bim.query.byType("y");' }],
      { namespace: 'com.acme.scripts' },
    );
    expect(r.extensions[0].id.startsWith('com.acme.scripts.')).toBe(true);
  });

  it('wraps source as a command handler', () => {
    const r = migrateSavedScripts([
      { id: 'q', name: 'Q', code: 'const w = bim.query.byType("IfcWall");' },
    ]);
    const handler = r.extensions[0].files['src/commands/run.js'];
    expect(handler).toContain('async function run(ctx)');
    expect(handler).toContain('const bim = ctx.bim');
  });
});
