/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ELEMENT_TYPES` is what `ifc-lite create` advertises -- in `--help`, in the
 * "Usage:" line when you pass no type, and in the "Supported:" list of the
 * error you get for an unknown one. So every entry has to actually build
 * something.
 *
 * `'storey'` did not. It was listed, so it passed the usage check, then fell
 * through `addElement`'s switch to the `default` arm, which fataled with
 * `Unknown element type: storey` -- and printed the very list that had just
 * offered it (#5531).
 *
 * Driving `addElement` for real rather than diffing the source against the
 * switch: a `case` that exists but throws, or returns an id belonging to no
 * entity, would satisfy a source comparison and still be broken.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { ELEMENT_TYPES, addElement } from './create.js';

/** A fresh project with one storey, exactly as `createCommand` sets up. */
function newProject() {
  const creator = new IfcCreator({ Name: 'Element type coverage' });
  const storey = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
  return { creator, storey };
}

/**
 * The two opening types are placed INTO a host wall rather than into the
 * storey, so they need that wall's expressId -- `createCommand` takes it as
 * `--wall-id`. Everything else defaults.
 */
function paramsFor(elementType: string, creator: IfcCreator, storey: number): Record<string, unknown> {
  if (elementType !== 'wall-door' && elementType !== 'wall-window') return {};
  return { WallId: creator.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Height: 3, Thickness: 0.2, Name: 'Host' }) };
}

describe('every advertised element type builds something', () => {
  it.each(ELEMENT_TYPES)('create %s', (elementType) => {
    const { creator, storey } = newProject();

    const id = addElement(creator, storey, elementType, paramsFor(elementType, creator, storey));

    expect(Number.isInteger(id), `${elementType} returned a non-id: ${String(id)}`).toBe(true);
    expect(id, `${elementType} returned a non-positive id`).toBeGreaterThan(0);

    // And the file it produces is a STEP file that actually contains that id.
    const { content } = creator.toIfc();
    expect(content.startsWith('ISO-10303-21;')).toBe(true);
    expect(content, `#${id} is absent from the emitted IFC`).toContain(`#${id}=`);
  });
});

describe('an unlisted type is still refused', () => {
  it('fatals rather than silently producing an empty project', () => {
    const { creator, storey } = newProject();
    expect(() => addElement(creator, storey, 'not-a-real-type', {})).toThrow();
  });
});
