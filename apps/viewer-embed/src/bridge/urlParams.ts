/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parse URL parameters for the embed viewer.
 *
 * URL format:
 *   /v1?modelUrl=https://...&theme=dark&select=42,43&view=front
 */

import type { EmbedUrlParams, ViewPreset } from '@ifc-lite/embed-protocol';

const VALID_VIEWS: ViewPreset[] = ['top', 'bottom', 'front', 'back', 'left', 'right'];

/**
 * Embed URL params plus viewer-side-only security knobs that are not part of
 * the public embed protocol surface:
 *  - allowOrigins: optional inbound origin allowlist. When set, the bridge
 *    drops postMessage commands whose event.origin is not on the list.
 *  - parentOrigin: optional expected parent origin used as the outbound
 *    targetOrigin for content-bearing events before the first inbound message
 *    is received (so auto-load events are not broadcast to '*').
 */
export interface EmbedViewerUrlParams extends EmbedUrlParams {
  allowOrigins?: string[];
  parentOrigin?: string;
}

/** Normalise an origin string (e.g. "https://app.example.com") or return null. */
function normaliseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch (error) {
    // Not a full URL — reject (caller falls back to the inbound handshake).
    console.warn('[embed] Ignoring invalid origin value', value, error);
    return null;
  }
}

const DEMO_MODELS: Record<string, string> = {
  default: '/demo/AC20-FZK-Haus.ifc',
};

/**
 * Validate a model URL against the http(s)-only allowlist and return its
 * resolved absolute href. Rejects javascript:, data:, file:, etc. so neither
 * the URL-param path nor the postMessage bridge depends solely on CSP.
 *
 * @throws Error if the URL is empty, malformed, or uses an unsupported scheme.
 */
export function assertFetchableUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Model URL must be a non-empty string');
  }
  const parsed = new URL(url, window.location.origin);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  return parsed.href;
}

export function parseUrlParams(): EmbedViewerUrlParams {
  const params = new URLSearchParams(window.location.search);
  const result: EmbedViewerUrlParams = {};

  const demo = params.get('demo');
  if (demo !== null) {
    const key = demo || 'default';
    result.modelUrl = DEMO_MODELS[key] ?? DEMO_MODELS.default;
  }

  const modelUrl = params.get('modelUrl');
  if (modelUrl) {
    // Only allow http(s) URLs to prevent javascript: or data: injection
    try {
      assertFetchableUrl(modelUrl);
      result.modelUrl = modelUrl;
    } catch (error) {
      // Invalid URL or unsupported scheme — skip, but surface why.
      console.warn('[embed] Ignoring invalid modelUrl query param', modelUrl, error);
    }
  }

  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') result.theme = theme;

  const bg = params.get('bg');
  // Only allow valid hex color characters (3, 6, or 8 hex digits)
  if (bg && /^[0-9a-fA-F]{3,8}$/.test(bg)) result.bg = bg;

  const controls = params.get('controls');
  if (controls === 'orbit' || controls === 'pan' || controls === 'all' || controls === 'none') {
    result.controls = controls;
  }

  const autoLoad = params.get('autoLoad');
  if (autoLoad !== null) result.autoLoad = autoLoad !== 'false';

  const hideAxis = params.get('hideAxis');
  if (hideAxis === 'true') result.hideAxis = true;

  const hideScale = params.get('hideScale');
  if (hideScale === 'true') result.hideScale = true;

  const select = params.get('select');
  if (select) {
    const ids = select.split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length > 0) result.select = ids;
  }

  const isolate = params.get('isolate');
  if (isolate) {
    const ids = isolate.split(',').map(Number).filter(n => !isNaN(n));
    if (ids.length > 0) result.isolate = ids;
  }

  const hideTypes = params.get('hideTypes');
  if (hideTypes) result.hideTypes = hideTypes.split(',').map(s => s.trim());

  const camera = params.get('camera');
  if (camera) {
    const parts = camera.split(',').map(Number);
    if (parts.length >= 2 && parts.every(n => !isNaN(n))) {
      result.camera = { azimuth: parts[0], elevation: parts[1], zoom: parts[2] };
    }
  }

  const view = params.get('view') as ViewPreset;
  if (VALID_VIEWS.includes(view)) result.view = view;

  // Optional inbound origin allowlist (comma-separated full origins).
  // When set, the bridge only accepts postMessage commands from these origins.
  const allowOrigin = params.get('allowOrigin');
  if (allowOrigin) {
    const origins = allowOrigin
      .split(',')
      .map(s => normaliseOrigin(s.trim()))
      .filter((o): o is string => o !== null);
    if (origins.length > 0) result.allowOrigins = origins;
  }

  // Optional expected parent origin used as the outbound targetOrigin for
  // content-bearing events before the first inbound message arrives.
  const parentOrigin = params.get('parentOrigin');
  if (parentOrigin) {
    const origin = normaliseOrigin(parentOrigin.trim());
    if (origin) result.parentOrigin = origin;
  }

  return result;
}
