/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Custom 3D Tiles tileset URL for the world context (issue #3607).
 *
 * Scope: consume an arbitrary user-supplied 3D Tiles tileset (e.g. Dutch 3D
 * BAG / PDOK data) as a Cesium context layer, the same role currently filled
 * by OSM tiles and Google Photorealistic 3D Tiles. Cesium's own loader
 * (`Cesium3DTileset.fromUrl`) parses both 3D Tiles 1.0 (B3DM) and 1.1 (glTF)
 * content transparently, so there is no spec-version handling here — this
 * module only validates the URL shape and words the runtime failure.
 */

/** Result of validating a user-entered tileset URL. */
export type ValidateTilesetUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/**
 * Validate a user-entered 3D Tiles URL. Mirrors the checks
 * `validateCustomBasemap` applies to the XYZ basemap URL: must be a real
 * http(s) URL, and must not embed credentials that would otherwise sit in
 * this browser's localStorage in cleartext.
 */
export function validateTilesetUrl(raw: string): ValidateTilesetUrlResult {
  const url = raw.trim();
  if (!url) return { ok: false, message: 'Enter a 3D Tiles URL, e.g. https://example.org/tileset.json' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'The tileset is fetched by the browser, so the URL must be http or https.' };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: 'Remove the username and password from the URL: they would be stored in this browser in cleartext and sent with every request.',
    };
  }
  return { ok: true, url };
}

/**
 * Word a failed `Cesium3DTileset.fromUrl(...)` call for the on-screen banner.
 * Covers a 404, a CORS rejection (fetch rejects with no readable status) and
 * a URL that resolves but is not a tileset (a JSON-parse or schema error from
 * Cesium's loader) — all surface here as one visible, actionable message
 * rather than a silent empty globe.
 */
export function tilesetLoadErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not load the custom 3D Tiles URL: ${detail}. Check that it points to a tileset.json and that the server allows browser access (CORS).`;
}
