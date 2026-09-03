/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutable state for the three overlay/visibility params that have no store
 * actuator of their own: `hideAxis`, `hideScale`, `hideTypes`. Seeded from the
 * URL params (matching every embed's behaviour up to #2934), but also
 * writable later — an INIT command's `config` payload names the same three
 * fields on the published `EmbedConfig` type (packages/embed-protocol), and
 * until this hook existed there was nowhere to put a later write: `EmbedViewer`
 * read `urlParams.hideAxis`/`.hideScale`/`.hideTypes` directly, a plain object
 * captured once in a `useState` initialiser, so INIT's `config.hideAxis` (etc.)
 * had a documented type and no write site — the same "declared but does
 * nothing" shape #2934 found for the URL params themselves.
 *
 * `hideAxis`/`hideScale` are used as `ViewportOverlays` props; `hideTypes` is
 * fed into `useHostHiddenIfcTypes` — see EmbedViewer.tsx.
 */

import { useState } from 'react';
import type { EmbedViewerUrlParams } from '../bridge/urlParams.js';

export interface EmbedRuntimeOverlays {
  hideAxis: boolean | undefined;
  hideScale: boolean | undefined;
  hideTypes: string[] | undefined;
  /** Merged setter matching handler.ts's BridgeContext.setOverlays shape 1:1 — pass straight through to initBridge. */
  setOverlays: (overlays: { hideAxis?: boolean; hideScale?: boolean; hideTypes?: string[] }) => void;
}

export function useEmbedRuntimeOverlays(urlParams: EmbedViewerUrlParams): EmbedRuntimeOverlays {
  const [hideAxis, setHideAxis] = useState(urlParams.hideAxis);
  const [hideScale, setHideScale] = useState(urlParams.hideScale);
  const [hideTypes, setHideTypes] = useState(urlParams.hideTypes);
  const setOverlays = (overlays: { hideAxis?: boolean; hideScale?: boolean; hideTypes?: string[] }) => {
    if (overlays.hideAxis !== undefined) setHideAxis(overlays.hideAxis);
    if (overlays.hideScale !== undefined) setHideScale(overlays.hideScale);
    if (overlays.hideTypes !== undefined) setHideTypes(overlays.hideTypes);
  };
  return { hideAxis, hideScale, hideTypes, setOverlays };
}
