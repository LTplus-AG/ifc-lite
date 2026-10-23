/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.viewer` with several cutting planes (#7545): a backend that implements them is called
 * directly; one that clips with a single plane (`setSection` / `getSection` only) still works,
 * seeing the first plane and reporting at most one.
 */

import { describe, it, expect, vi } from 'vitest';
import { ViewerNamespace } from './viewer.js';
import type { BimBackend } from '../types.js';
import type { SectionPlane } from '../section-plane.js';

const PLANE = (axis: SectionPlane['axis'], position: number): SectionPlane => ({ axis, position, enabled: true, flipped: false });

function namespace(viewer: Record<string, unknown>): ViewerNamespace {
  return new ViewerNamespace({ viewer } as unknown as BimBackend);
}

describe('bim.viewer sections on a multi-plane backend', () => {
  it('forwards each call to the backend', () => {
    const viewer = {
      setSections: vi.fn(), getSections: vi.fn(() => [PLANE('x', 1)]),
      addSection: vi.fn(() => 'p2'), removeSection: vi.fn(() => true),
      setSection: vi.fn(), getSection: vi.fn(),
    };
    const bim = namespace(viewer);
    bim.setSections([PLANE('x', 1), PLANE('y', 2)]);
    expect(viewer.setSections).toHaveBeenCalledWith([PLANE('x', 1), PLANE('y', 2)]);
    expect(bim.getSections()).toEqual([PLANE('x', 1)]);
    expect(bim.addSection(PLANE('z', 3))).toBe('p2');
    expect(bim.removeSection('p2')).toBe(true);
    expect(viewer.setSection).not.toHaveBeenCalled();
  });
});

describe('bim.viewer sections on a single-plane backend', () => {
  it('reports the one plane, applies the first, and cannot remove by id', () => {
    const viewer = { setSection: vi.fn(), getSection: vi.fn(() => PLANE('y', 40)) };
    const bim = namespace(viewer);
    expect(bim.getSections()).toEqual([PLANE('y', 40)]);
    bim.setSections([PLANE('x', 1), PLANE('y', 2)]);
    expect(viewer.setSection).toHaveBeenLastCalledWith(PLANE('x', 1));
    bim.setSections([{ ...PLANE('x', 9), enabled: false }, PLANE('y', 2)]);
    expect(viewer.setSection).toHaveBeenLastCalledWith(PLANE('y', 2));
    bim.setSections([]);
    expect(viewer.setSection).toHaveBeenLastCalledWith(null);
    expect(bim.addSection(PLANE('z', 3))).toBeNull();
    expect(viewer.setSection).toHaveBeenLastCalledWith(PLANE('z', 3));
    expect(bim.removeSection('p1')).toBe(false);
  });

  it('with no plane at all, reports none', () => {
    expect(namespace({ setSection: vi.fn(), getSection: vi.fn(() => null) }).getSections()).toEqual([]);
  });
});
