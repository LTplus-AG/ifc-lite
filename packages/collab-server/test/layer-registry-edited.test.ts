/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edit-in-place resolutions over the registry merge route (08-review.md
 * §8.3): the review UI can replace a conflicting component with typed
 * attributes instead of picking a side. Malformed shapes are 400s, and
 * the engine's edited-target rules surface as client errors, not 500s.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import { startCollabServer, type CollabServerHandle } from '../src/index.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const CLASS = 'bsi::ifc::class';

function publishable(nodes: IfcxNode[], intent: string, base: ProvenanceBase | null): IfcxFile {
  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-06-10T00:00:00.000Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base,
    created: '2026-06-10T00:00:00.000Z',
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

describe('edited resolutions over the merge route', () => {
  let handle: CollabServerHandle;
  let api: string;

  beforeAll(async () => {
    handle = await startCollabServer({ port: 0, layerRegistry: true });
    const port = (handle.httpServer.address() as { port: number }).port;
    api = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('merges a conflict with reviewer-typed replacement attributes', async () => {
    const base = publishable(
      [{ path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } }],
      'Base',
      null
    );
    const ours = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }],
      'Ours',
      { kind: 'stack', id: computeStackHash([base.header.id]) }
    );
    const candidate = publishable(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }],
      'Theirs',
      { kind: 'stack', id: computeStackHash([base.header.id]) }
    );
    for (const layer of [base, ours, candidate]) {
      expect((await fetch(`${api}/layers`, { method: 'POST', body: JSON.stringify(layer) })).status).toBe(201);
    }
    expect(
      (
        await fetch(`${api}/refs/main`, {
          method: 'PUT',
          body: JSON.stringify({ layers: [base.header.id, ours.header.id] }),
        })
      ).status
    ).toBe(201);

    // Unresolved: conflicts ride a 409.
    const conflicted = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({ candidate: candidate.header.id }),
    });
    expect(conflicted.status).toBe(409);

    // Malformed edited shapes are client errors.
    const missingAttrs = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({
        candidate: candidate.header.id,
        resolutions: [{ path: 'wall-1', component_key: 'pset:Pset_FireSafety', choice: 'edited' }],
      }),
    });
    expect(missingAttrs.status).toBe(400);
    const arrayAttrs = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({
        candidate: candidate.header.id,
        resolutions: [
          { path: 'wall-1', component_key: 'pset:Pset_FireSafety', choice: 'edited', attributes: [1, 2] },
        ],
      }),
    });
    expect(arrayAttrs.status).toBe(400);

    // A reviewer-typed value that is neither side wins the merge.
    const merged = await fetch(`${api}/refs/main/merge`, {
      method: 'POST',
      body: JSON.stringify({
        candidate: candidate.header.id,
        resolutions: [
          {
            path: 'wall-1',
            component_key: 'pset:Pset_FireSafety',
            choice: 'edited',
            attributes: { [FIRE]: 'REI180' },
          },
        ],
      }),
    });
    expect(merged.status).toBe(200);
    const outcome = (await merged.json()) as { status: string; layers: string[] };
    expect(outcome.status).toBe('merged');

    const files: IfcxFile[] = [];
    for (const id of outcome.layers) {
      files.push((await (await fetch(`${api}/layers/${id}`)).json()) as IfcxFile);
    }
    const state = extractStackState(files);
    expect(state.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({ [FIRE]: 'REI180' });
  });
});
