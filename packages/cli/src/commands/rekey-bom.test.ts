/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's CSV downloads start with a UTF-8 BOM so Excel opens them as
 * UTF-8. Node's `readFile(.., 'utf8')` keeps that BOM, so without a strip the
 * first header reads `﻿GlobalId` and rekey reports the column missing.
 * `@ifc-lite/diff` is stubbed: `parseCsv` is pure and the real module needs wasm; `@ifc-lite/export` is only used by the writer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ifc-lite/diff', () => ({}));
vi.mock('@ifc-lite/export', () => ({}));

import { parseCsv } from './rekey.js';

describe('rekey parseCsv', () => {
  it('drops a leading UTF-8 BOM from the first header', () => {
    const { header, rows } = parseCsv('﻿GlobalId,Cost\nw,100\n');
    expect(header).toEqual(['GlobalId', 'Cost']);
    expect(rows).toEqual([{ GlobalId: 'w', Cost: '100' }]);
  });

  it('leaves a BOM-free table unchanged', () => {
    expect(parseCsv('GlobalId,Cost\nw,100\n').header).toEqual(['GlobalId', 'Cost']);
  });
});
