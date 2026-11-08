/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { canonicalQuantityIds as canonical } from './canonical-quantity-ids.js';

const canonicalQuantityIds = (content: string) => canonical(content, new Set([10]));

const model = (offset: number, value = 3, owner = 10, label = 'NetVolume #99') => [
  "#10=IFCWALL('wall',$,'Wall',$,$,$,$,$,$);",
  `#${offset}=IFCQUANTITYVOLUME('${label}',$,$,${value},$);`,
  `#${offset + 1}=IFCELEMENTQUANTITY('set',$,'Qto_WallBaseQuantities',$,$,(#${offset}));`,
  `#${offset + 2}=IFCRELDEFINESBYPROPERTIES('rel',$,$,$,(#${owner}),#${offset + 1});`,
].join('\n');

it('#9296 compares transient quantity ids without losing values, owners, strings or physical source ids', () => {
  const before = canonicalQuantityIds(model(100));
  expect(canonicalQuantityIds(model(200))).toBe(before);
  expect(canonicalQuantityIds(model(200, 4))).not.toBe(before);
  expect(canonicalQuantityIds(model(200, 3, 11))).not.toBe(before);
  expect(canonicalQuantityIds(model(200, 3, 10, 'NetVolume #100'))).not.toBe(before);
  expect(canonicalQuantityIds(model(200).replace("#10=IFCWALL", "#11=IFCWALL"))).not.toBe(before);
});


it('#9355 preserves loaded quantity set, leaf and relationship EXPRESS ids', () => {
  const sourceIds = new Set([10, 100, 101, 102]);
  const before = canonical(model(100), sourceIds);
  expect(canonical(model(200), sourceIds)).not.toBe(before);
  expect(canonical(model(100).replace('#102=', '#202='), sourceIds)).not.toBe(before);
  expect(canonical(model(100).replaceAll('#100', '#200'), sourceIds)).not.toBe(before);
});

it('#9355 overlay-authored quantity records retain their persistent identity', () => {
  const overlayIds = new Set([10, 100, 101, 102, 200, 201, 202]);
  expect(canonical(model(100), overlayIds)).not.toBe(canonical(model(200), overlayIds));
});
