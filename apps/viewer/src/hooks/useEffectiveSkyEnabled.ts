/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sky/atmosphere flag as actually applied to the active rendering path.
 *
 * `envSkyEnabled` itself rests at `false` by default (environmentSlice) so
 * WebGPU's preset behaviour, which the flag is shared with, is untouched.
 * The Cesium world context is on by default instead (#4771) — layered on
 * here via `resolveSkyEnabled` rather than in the slice's own default — but
 * only until the user has ever explicitly toggled it, at which point their
 * persisted choice (on OR off) wins in either context.
 */

import { useViewerStore } from '@/store';
import { resolveSkyEnabled } from '@/store/slices/environmentSlice';

export function useEffectiveSkyEnabled(): boolean {
  const envSkyEnabled = useViewerStore((s) => s.envSkyEnabled);
  const envSkyEnabledSetByUser = useViewerStore((s) => s.envSkyEnabledSetByUser);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  return resolveSkyEnabled(envSkyEnabled, envSkyEnabledSetByUser, cesiumEnabled);
}
