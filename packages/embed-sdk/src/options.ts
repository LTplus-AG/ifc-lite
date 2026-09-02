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
  /**
   * Set `false` to suppress the automatic fetch of `modelUrl`, leaving the
   * viewer mounted and empty until the host loads something itself. Omitted
   * and `true` both mean "load", matching the viewer's default — only an
   * explicit `false` is serialised, because the parser treats every value
   * other than the literal `'false'` as `true`.
   */
  autoLoad?: boolean;
  /** Color theme */
  theme?: 'light' | 'dark';
  /** Custom background color (hex without #) */
  bg?: string;
  /**
   * Restrict interactive orbit/pan/zoom. `'orbit'`/`'pan'` allow only that
   * gesture, `'none'` freezes the view, `'all'` is unrestricted. Programmatic
   * moves (`setCamera`, `view`/`camera` options, SDK calls) are unaffected.
   */
  controls?: 'orbit' | 'pan' | 'all' | 'none';
  /** Hide the axis helper. */
  hideAxis?: boolean;
  /** Hide the scale bar. */
  hideScale?: boolean;
  /**
   * IFC class names to hide, matched case-insensitively (`IFCSPACE` === `IfcSpace`).
   *
   * Takes precedence over `setTypeVisibility`: the two are ANDed, so naming a class
   * here that also has a visibility toggle keeps it hidden even after a later
   * `setTypeVisibility({ spaces: true })`. There is no call that un-hides a
   * `hideTypes` entry; re-initialise the embed to change the list.
   *
   * Hides meshes AND the symbolic 2D overlay (dimension lines, drawing text,
   * grid bubbles), which is not a mesh and so needed a route of its own (#2934).
   *
   * For the overlay, matching is on the class that OWNS the drawn content, which
   * is worth spelling out. Dimensions, leaders and room tags are owned by
   * `IfcAnnotation`; grid axes and their bubbles by `IfcGridAxis` — NOT by
   * `IfcGrid`, which owns no drawn content and therefore hides nothing. Naming a
   * wall or a space removes their meshes and no 2D content: their `Axis` and
   * `FootPrint` representations are not drawn in the 3D viewport at all.
   *
   * An overlay channel switches off only when every owner class it draws is
   * named, so hiding one class can never take another's content with it.
   */
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
  if (opts.autoLoad === false) params.set('autoLoad', 'false');
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
