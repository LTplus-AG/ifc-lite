/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stands in for every `~icons/viewer/*` virtual module under `tsx --test`
 * (#2434). See `vite-module-hooks.mjs` for why the substitution has to happen
 * in a loader hook rather than a test file.
 *
 * It renders a real `<svg>` so layout, `aria-hidden` and click targets behave
 * like the shipped icon. It is deliberately identity-free: a test that needs to
 * know WHICH icon rendered should assert on the control's accessible name, not
 * on the glyph, because the glyph is exactly the detail unplugin-icons owns.
 */

import type { SVGProps } from 'react';

export default function IconStub(props: SVGProps<SVGSVGElement>) {
  return <svg data-testid="icon-stub" aria-hidden="true" width="1em" height="1em" {...props} />;
}
