/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wakes `projector` whenever `dependency` changes value (React's `Object.is`
 * comparison), not just on mount (#5636 review). `registerAnchor` only
 * wakes the projector once, at registration; a prop-driven world-point (or
 * corner, or any other anchor input) move while the camera is static needs
 * its own wake, or the anchor sits at its stale screen position until an
 * unrelated camera/registration event happens to wake the loop.
 *
 * `dependency` is deliberately a single value (a number, string, or the
 * `vec3Key`/`cornerKey`-style string a caller combining several numbers
 * builds), not a spread array of numbers: `useEffect`'s dependency array
 * must stay the same LENGTH every render, which a variable-length input
 * (e.g. `PlaneOutline`'s corner count) would violate.
 */

import { useEffect } from 'react';
import type { SceneProjector } from './projector';

export function useWakeOnChange(projector: SceneProjector | null, dependency: string | number | null | undefined): void {
  useEffect(() => {
    projector?.notifyAnchorsChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projector, dependency]);
}
