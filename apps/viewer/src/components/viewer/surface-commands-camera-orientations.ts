/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orbit } from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { emitCameraInteracted } from '@/lib/tours/events';
import { PALETTE_CAMERA_ORIENTATIONS } from './palette-camera-orientations';
import type { SurfaceCommandDefinition } from './surface-command-types';

const LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  "-1,1,1": "commandPalette.view.orientation.front-left-top",
  "0,1,1": "commandPalette.view.orientation.front-top",
  "1,1,1": "commandPalette.view.orientation.front-right-top",
  "-1,0,1": "commandPalette.view.orientation.front-left",
  "1,0,1": "commandPalette.view.orientation.front-right",
  "-1,-1,1": "commandPalette.view.orientation.front-left-bottom",
  "0,-1,1": "commandPalette.view.orientation.front-bottom",
  "1,-1,1": "commandPalette.view.orientation.front-right-bottom",
  "1,1,-1": "commandPalette.view.orientation.back-right-top",
  "0,1,-1": "commandPalette.view.orientation.back-top",
  "-1,1,-1": "commandPalette.view.orientation.back-left-top",
  "1,0,-1": "commandPalette.view.orientation.back-right",
  "-1,0,-1": "commandPalette.view.orientation.back-left",
  "1,-1,-1": "commandPalette.view.orientation.back-right-bottom",
  "0,-1,-1": "commandPalette.view.orientation.back-bottom",
  "-1,-1,-1": "commandPalette.view.orientation.back-left-bottom",
  "1,1,0": "commandPalette.view.orientation.right-top",
  "1,-1,0": "commandPalette.view.orientation.right-bottom",
  "-1,1,0": "commandPalette.view.orientation.left-top",
  "-1,-1,0": "commandPalette.view.orientation.left-bottom"
};

/** Presets reuse ViewCube's geometry and the renderer's existing direction action. */
export const CAMERA_ORIENTATION_COMMANDS = PALETTE_CAMERA_ORIENTATIONS.map(preset => {
  const labelKey = LABEL_KEYS[preset.key];
  if (!labelKey) throw new Error(`Missing camera orientation label: ${preset.key}`);
  return {
    id: `view:orientation:${preset.faces.join('-')}` as const,
    labelKey,
    keywords: `camera view cube orientation ${preset.kind} ${preset.faces.join(' ')}`,
    category: 'View', icon: Orbit, surfaces: ['palette'] as const,
    enabled: () => true,
    run: () => {
      const setDirection = useViewerStore.getState().cameraCallbacks.setPresetDirection;
      if (!setDirection) return;
      setDirection(preset.direction);
      emitCameraInteracted('preset');
    },
  } satisfies SurfaceCommandDefinition;
});
