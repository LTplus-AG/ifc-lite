/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Applies an INIT command's optional `config` payload (the published
 * `EmbedConfig` type from `@ifc-lite/embed-protocol`) to the store and bridge
 * context.
 *
 * Before this, `handler.ts`'s INIT case read only `config.theme`. The other
 * five fields — `bg`, `controls`, `hideAxis`, `hideScale`, `hideTypes` — are
 * declared on the same exported type, mirror the `?bg=`/`?controls=`/etc. URL
 * params exactly, and were silently dropped: a real integration driving the
 * postMessage protocol directly (not through the SDK, which never populates
 * `config` at all) would set them on INIT expecting the same effect the URL
 * params get, and nothing would happen. Each case below reuses the identical
 * actuator its URL-param equivalent already calls, so INIT and the URL params
 * can't drift from each other.
 */

import type { EmbedConfig } from '@ifc-lite/embed-protocol';

export interface InitConfigActuators {
  setTheme: (theme: 'light' | 'dark') => void;
  setInteractionMode: (mode: NonNullable<EmbedConfig['controls']>) => void;
  setBackgroundColor: (bg: string | undefined) => void;
  /** Merged sink for the three URL-only overlay params: hideAxis, hideScale, hideTypes. */
  setOverlays: (overlays: Pick<EmbedConfig, 'hideAxis' | 'hideScale' | 'hideTypes'>) => void;
}

export function applyInitConfig(config: EmbedConfig | undefined, actuators: InitConfigActuators): void {
  if (!config) return;
  if (config.theme) actuators.setTheme(config.theme);
  if (config.bg !== undefined) actuators.setBackgroundColor(config.bg);
  if (config.controls) actuators.setInteractionMode(config.controls);
  const { hideAxis, hideScale, hideTypes } = config;
  if (hideAxis !== undefined || hideScale !== undefined || hideTypes !== undefined) {
    actuators.setOverlays({ hideAxis, hideScale, hideTypes });
  }
}
