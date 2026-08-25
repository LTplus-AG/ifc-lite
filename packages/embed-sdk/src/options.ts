/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Embed options and their URL serialisation.
 *
 * The iframe URL is the SDK's only pre-handshake channel, so every option the
 * viewer reads at startup has to be a query parameter here. Anything secret
 * (the auth token) is deliberately absent -- it travels by postMessage.
 */

import type { ViewPreset } from '@ifc-lite/embed-protocol';

export interface EmbedOptions {
  /** CSS selector or DOM element to mount the iframe into */
  container: string | HTMLElement;
  /** URL of the model to load on initialization */
  modelUrl?: string;
  /** Color theme */
  theme?: 'light' | 'dark';
  /** Custom background color (hex without #) */
  bg?: string;
  /** Camera controls mode. NOT YET IMPLEMENTED — sent, and the viewer ignores it. */
  controls?: 'orbit' | 'pan' | 'all' | 'none';
  /** Hide the axis helper. NOT YET IMPLEMENTED — sent, and the viewer ignores it. */
  hideAxis?: boolean;
  /** Hide the scale bar. NOT YET IMPLEMENTED — sent, and the viewer ignores it. */
  hideScale?: boolean;
  /** IFC class names to hide, matched case-insensitively (`IFCSPACE` === `IfcSpace`). */
  hideTypes?: string[];
  /**
   * Entity ids to select once the first model is on screen. The viewer keeps
   * only positive integers, so a non-integer or non-positive id is dropped
   * there rather than reported back here.
   */
  select?: number[];
  /** Entity ids to isolate once the first model is on screen. Same id rule as `select`. */
  isolate?: number[];
  /** Preset camera view. Takes precedence over `camera`. */
  view?: ViewPreset;
  /**
   * Initial absolute camera orientation in degrees; the model is framed at
   * that orientation. `zoom` is accepted but NOT applied — the viewer has no
   * absolute-zoom actuator and the field carries no unit.
   */
  camera?: { azimuth: number; elevation: number; zoom?: number };
  /** Origin of the hosted embed viewer (defaults to production) */
  origin?: string;
  /** Auth token (sent via postMessage, not URL) */
  token?: string;
  /** Handshake timeout in ms (default: 15000) */
  timeout?: number;
}

/**
 * Serialise the non-sensitive options into the iframe query string.
 *
 * Falsy-but-meaningful values are the trap here: a zero zoom is a real pose,
 * and an empty `hideTypes`/`select`/`isolate` array is not a request to hide,
 * select or isolate nothing, so both are decided on length, never on truthiness.
 */
export function embedUrlSearchParams(opts: EmbedOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.modelUrl) params.set('modelUrl', opts.modelUrl);
  if (opts.theme) params.set('theme', opts.theme);
  if (opts.bg) params.set('bg', opts.bg);
  if (opts.controls) params.set('controls', opts.controls);
  if (opts.hideAxis) params.set('hideAxis', 'true');
  if (opts.hideScale) params.set('hideScale', 'true');
  if (opts.hideTypes?.length) params.set('hideTypes', opts.hideTypes.join(','));
  if (opts.select?.length) params.set('select', opts.select.join(','));
  if (opts.isolate?.length) params.set('isolate', opts.isolate.join(','));
  if (opts.view) params.set('view', opts.view);
  if (opts.camera) {
    const parts = [opts.camera.azimuth, opts.camera.elevation];
    if (opts.camera.zoom !== undefined) parts.push(opts.camera.zoom);
    params.set('camera', parts.join(','));
  }
  return params;
}
