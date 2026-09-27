/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `element.split` command's scene layer (#6232; was the Split tool's
 * `TOOL_HUD` row, #5503): the SVG cut preview plus the cursor-anchored
 * distance entry. Siblings rather than nested, so the SVG layer stays
 * `pointer-events-none` while the input is interactive. The bar (label,
 * close) and the hint come from the generic command HUD.
 */

import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { SplitGesture } from '@/lib/commands/modeling/commands/element-split';
import { SplitOverlay } from './SplitOverlay';
import { SplitCursorInput } from './SplitCursorInput';

export function SplitScene({ gesture }: CommandHudProps<SplitGesture>) {
  return (
    <>
      <SplitOverlay gesture={gesture} />
      <SplitCursorInput gesture={gesture} />
    </>
  );
}
