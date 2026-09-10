/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcTypeEnum, type SpatialNode } from './types.js';
import { spatialLookups } from './spatial-lookups.js';

it('retains depth-first path precedence and terminates malformed cycles (#4308)', () => {
  const node = (expressId: number): SpatialNode => ({ expressId, type: IfcTypeEnum.IfcSpace, name: '', children: [], elements: [] });
  const project = node(1), first = node(2), nested = node(3), second = node(4);
  project.children = [first, second]; first.children = [nested]; nested.children = [project];
  nested.elements = [9]; second.elements = [9];
  const lookup = spatialLookups(project, new Map());
  expect(lookup.getPath(9).map(item => item.expressId)).toEqual([1, 2, 3]);
  expect(lookup.getPath(100)).toEqual([]);
});

it('older transport without a reverse index observes later membership changes (#4308)', () => {
  const project: SpatialNode = { expressId: 1, type: IfcTypeEnum.IfcProject, name: '', children: [], elements: [] };
  const elements = [3];
  const lookup = spatialLookups(project, new Map([[2, elements]]));
  expect(lookup.getContainingSpace(3)).toBe(2);
  elements.splice(0, 1, 4);
  expect(lookup.getContainingSpace(3)).toBeNull();
  expect(lookup.getContainingSpace(4)).toBe(2);
});
