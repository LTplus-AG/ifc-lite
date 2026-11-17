/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { readRhino3dm, RhinoReadError } from '../index.js';
import { loadRhino } from '../runtime.js';
import { craft } from '../../test-support/craft.js';
import { orderLayers, rows, type RLayerFacts } from './document.js';
import { loadIfcClasses } from './ifc-classes.js';
import { Report } from './report.js';

const classes = await loadIfcClasses();
const layer = (name: string, id: string, parentId = '00000000-0000-0000-0000-000000000000'): RLayerFacts =>
  ({ id, parentId, name, color: [0, 0, 0, 255], visible: true, material: -1, userStrings: [] });

/** A stand-in for an embind wrapper: `rows` releases every row and the table through `delete()`. */
class Handle {
  released = false;
  constructor(readonly name = '') {}
  delete(): void { this.released = true; }
}

describe('table rows', () => {
  // Review finding on PR #9880, deferred to issue #10021.
  test('a row the binding does not hand out is reported as a damaged file, not a TypeError', () => {
    const table = Object.assign(new Handle(), { count: 2, get: (i: number) => (i === 0 ? new Handle('first') : null) });
    const read = (row: Handle | null) => row!.name;
    expect(() => rows(table, read)).toThrow(RhinoReadError);
    expect(() => rows(table, read)).toThrow('Not a Rhino .3dm file, or the file is damaged.');
    // The table is still released on the way out.
    expect(table.released).toBe(true);
  });

  test('every row of a table that agrees with its count is read in order, and each is released', () => {
    const handed: Handle[] = [];
    const table = Object.assign(new Handle(), { count: 3, get: (i: number) => { const row = new Handle(`row ${i}`); handed.push(row); return row; } });
    expect(rows(table, row => row.name)).toEqual(['row 0', 'row 1', 'row 2']);
    expect(handed.map(row => row.released)).toEqual([true, true, true]);
  });
});

describe('layer paths', () => {
  test('a nested layer takes the path of the parent this walk settled on', () => {
    const report = new Report();
    const { layers, layerIndex } = orderLayers([
      layer('Site', 'a'), layer('Level 1', 'b', 'a'), layer('Walls', 'c', 'b'),
    ], classes, report);
    expect(layers.map(l => l.fullPath)).toEqual(['Site', 'Site::Level 1', 'Site::Level 1::Walls']);
    expect([layerIndex, report.warnings()]).toEqual([[0, 1, 2], []]);
  });

  // Issue #10021: the path used to come from the native property, which walks `ParentId` with no
  // visited set, so a cyclic chain never came back. It is built from the repaired tree instead.
  test('layers that are their own ancestors become roots, and their paths say so', () => {
    const report = new Report();
    const { layers } = orderLayers([
      layer('Root', 'a'), layer('Loop', 'b', 'c'), layer('Back', 'c', 'b'), layer('Under', 'd', 'b'),
    ], classes, report);
    // The cycle is broken at the first of its layers, which is shown at the top level under its own
    // name; what hangs off it keeps its place and reads as nested from there.
    expect(layers.map(l => [l.fullPath, l.parent])).toEqual([
      ['Root', null], ['Loop', null], ['Loop::Back', 1], ['Loop::Under', 1],
    ]);
    expect(report.warnings()).toEqual(['Some layers are their own ancestors; they are shown at the top level.']);
  });

  test('a layer whose parent is not in the file is a root, with no warning', () => {
    const report = new Report();
    const { layers } = orderLayers([layer('Orphan', 'a', 'missing'), layer('Child', 'b', 'a')], classes, report);
    expect(layers.map(l => l.fullPath)).toEqual(['Orphan', 'Orphan::Child']);
    expect(report.warnings()).toEqual([]);
  });

  test('paths through a real archive match the separator Rhino writes', async () => {
    const bytes = await craft(c => {
      const site = c.layer('Site'), level = c.layer('Level 1', { parent: site });
      c.addMesh(c.box([0, 0, 0], [1, 1, 1]), { layer: level });
    });
    const result = await readRhino3dm(bytes);
    expect(result.layers.map(l => l.fullPath)).toEqual(['Site', 'Site::Level 1']);
    // Against the binding rather than our own constant. Reading the native property is safe for
    // this chain because it is acyclic; that is the whole of what `orderLayers` had to replace.
    const file = (await loadRhino()).File3dm.fromByteArray(bytes);
    expect(file && rows(file.layers(), l => l.fullPath)).toEqual(['Site', 'Site::Level 1']);
  });

  /**
   * Why the path is built here rather than read from `Layer.fullPath`. The child is killed while
   * the native call is still running, which is the point: it does not return. The wait for the
   * cycle is open-ended, so a slow machine costs time rather than a failure, and only the window
   * the call itself gets is fixed. If this ever fails because the child printed a path, rhino3dm
   * has grown a visited set and `orderLayers` could read the property again.
   */
  test('rhino3dm 8.35.0 never returns from the native fullPath of a cyclic chain', async () => {
    const child = spawn(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../../test-support/layer-cycle-path.ts', import.meta.url)),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', ended: string | null = null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });
    child.on('exit', (code, signal) => { ended ??= `code ${code}, signal ${signal}`; });
    try {
      // The cycle is built before the call is made, so this fails rather than passes if the child
      // never got that far.
      await vi.waitFor(() => expect(out, err).toContain('cycle built: true'), { timeout: 20_000, interval: 50 });
      // Orders of magnitude more than a terminating walk of two layers would need.
      await new Promise(resolve => setTimeout(resolve, 2_000));
      // A child that died in the window prints no path either, which would pass the assertion
      // below while measuring nothing. It has to be in the call when the window closes.
      expect(ended, `the child ended instead of running the native call: ${err}`).toBe(null);
      expect(out, 'the native fullPath returned on a cyclic chain').not.toContain('full path:');
    } finally {
      child.kill('SIGKILL');
      if (ended === null) await new Promise(resolve => child.once('exit', resolve));
    }
  }, 30_000);
});
