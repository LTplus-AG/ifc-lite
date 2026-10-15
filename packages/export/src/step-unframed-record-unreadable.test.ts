/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7682 (review of EXPORT-STEP-1), the TypeScript half of
 * `step_log_refusals.rs::an_edit_on_an_indexed_record_the_frame_cannot_read_is_reported_7682`.
 *
 * A line that declares an entity instance (`#N=`) but has no record frame (a
 * complex instance, a non-ASCII character after the `=` or before the `(`) is
 * an UNREADABLE record: the named edit queued for it is dropped and the
 * pipeline must say so (`unreadable`), not pass it over as "no argument list".
 * The parser does not index these shapes today, so the pipeline is driven
 * directly, with the line a scanner that does index them would hand it.
 */

import { describe, expect, it } from 'vitest';
import { applySourceLineMutations } from './step-attribute-mutations.js';

describe('an edit on a record with no frame is reported (#7682)', () => {
  for (const line of [
    "#2=(IFCA('x')IFCB(1));",
    "#2= IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Wall B',$,$,$,$,$,$);",
    "#2=IFCWALL ('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Wall B',$,$,$,$,$,$);",
  ]) {
    it(JSON.stringify(line), () => {
      const out = applySourceLineMutations(null, 2, line, 'IFCWALL', new Map([['Name', 'y']]), 'IFC4', false);
      expect(out.text).toBe(line);
      expect(out.attributed).toBe(false);
      expect(out.unreadable).toBe(true);
    });
  }

  it('a line that declares no instance is not unreadable', () => {
    const out = applySourceLineMutations(null, 2, 'ENDSEC;', 'IFCWALL', new Map([['Name', 'y']]), 'IFC4', false);
    expect(out.unreadable).toBe(false);
  });
});
