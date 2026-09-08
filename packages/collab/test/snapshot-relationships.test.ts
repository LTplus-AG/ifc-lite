/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a snapshot does — and does not — carry for the `relationships`
 * branch.
 *
 * The Y.Doc keeps relationships in their own top-level map (spec §5.2),
 * but IFCX has no relationship node: composition is expressed through a
 * node's `children` / `inherits`, and that is what `snapshotToIfcx`
 * writes. So a relationship put in that map does not survive a snapshot,
 * and this file pins that as the deliberate state it is rather than
 * leaving it to be discovered as data loss.
 *
 * Why it is not (yet) a bug worth inventing a wire form for: no
 * first-party writer populates the map. `seedFromStep` maps IFC spatial
 * containment onto entity `children`, `seedFromIfcx` reads IFCX
 * `children` / `inherits`, and the viewer, MCP and CLI paths all go
 * through those. `createRelationship` has no production caller — the map
 * is public API surface with tests and no producer. Giving it a wire
 * representation is a format decision (which IFCX key? whose semantics?)
 * and belongs to whoever adds the first producer, together with them.
 *
 * If that day comes, the first test below starts failing, which is the
 * point: it is a tripwire, not an endorsement.
 */

import { describe, expect, it } from 'vitest';
import { createCollabDoc, relationshipsMap } from '../src/doc/schema.js';
import { createEntity } from '../src/doc/entity.js';
import { createRelationship } from '../src/doc/relationship.js';
import { seedFromIfcx } from '../src/snapshot/from-ifcx.js';
import { snapshotToIfcx } from '../src/snapshot/to-ifcx.js';

describe('relationships across a snapshot', () => {
  it('are not carried by IFCX — the wire has no relationship node (tripwire)', () => {
    const source = createCollabDoc();
    source.transact(() => {
      createEntity(source, 'storey', { ifcClass: 'IfcBuildingStorey' });
      createEntity(source, 'wall', { ifcClass: 'IfcWall' });
      createRelationship(source, 'rel-1', {
        ifcClass: 'IfcRelContainedInSpatialStructure',
        source: 'storey',
        targets: ['wall'],
      });
    });

    const file = snapshotToIfcx(source);
    // Nothing in the file names the relationship, by any spelling.
    expect(JSON.stringify(file)).not.toContain('rel-1');

    const restored = createCollabDoc();
    seedFromIfcx(restored, file);
    expect(relationshipsMap(restored).size).toBe(0);
    // The entities themselves are fine — only the separate branch is lost.
    expect(Array.from(restored.getMap('entities').keys()).sort()).toEqual(['storey', 'wall']);
  });

  it('the same containment expressed as `children` does survive', () => {
    const source = createCollabDoc();
    source.transact(() => {
      createEntity(source, 'wall', { ifcClass: 'IfcWall' });
      createEntity(source, 'storey', {
        ifcClass: 'IfcBuildingStorey',
        children: { wall: 'wall' },
      });
    });

    const restored = createCollabDoc();
    seedFromIfcx(restored, snapshotToIfcx(source));
    const storey = restored.getMap('entities').get('storey') as import('yjs').Map<unknown>;
    const children = storey.get('children') as import('yjs').Map<string>;
    expect(children.get('wall')).toBe('wall');
  });
});
