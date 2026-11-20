/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The content blocks a tab may put in a `result` (#9523): text, and images
 * once the bridge advertised {@link BRIDGE_FEATURE_IMAGE_CONTENT} in its
 * `welcome`. Browser-safe (no Buffer: `atob` only). Re-exported by
 * `protocol.ts`.
 *
 * An image is checked strictly before it reaches the agent: an allowlisted
 * MIME type, canonical base64, a size cap, a per-result count cap, and the
 * decoded file signature must match the declared type.
 */

import { isRecord } from './json-bounds.js';

/** `welcome.features` entry: this bridge forwards `image` result content. Older bridges refuse it. */
export const BRIDGE_FEATURE_IMAGE_CONTENT = 'image-content';

/** Every feature this bridge advertises in `welcome.features`. */
export const BRIDGE_FEATURES: readonly string[] = [BRIDGE_FEATURE_IMAGE_CONTENT];

export const BRIDGE_IMAGE_LIMITS = {
  /** Base64 characters of one image. Leaves room for text under `maxResultBytes` (4 MiB). */
  maxImageBytes: 3 * 1024 * 1024,
  /** Image blocks in one result. */
  maxImagesPerResult: 2,
} as const;

export interface BridgeTextContent {
  type: 'text';
  text: string;
}

export type BridgeImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** An image as MCP `ImageContent`: `data` is base64 of the file bytes. */
export interface BridgeImageContent {
  type: 'image';
  data: string;
  mimeType: BridgeImageMimeType;
}

export type BridgeContent = BridgeTextContent | BridgeImageContent;

/** File signature per type, checked on the decoded prefix. `null` matches any byte. */
const SIGNATURES: Record<BridgeImageMimeType, ReadonlyArray<number | null>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  // RIFF <size:4> WEBP
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Two pads leave four unused bits in the last sextet. One pad leaves two.
const BASE64_PADDING = /(?:[AQgw]==|[AEIMQUYcgkosw048]=)$/;

function isMimeType(v: unknown): v is BridgeImageMimeType {
  return typeof v === 'string' && Object.hasOwn(SIGNATURES, v);
}

/** Why `data` is not a valid `mimeType` image, or null when it is. */
function imageContentError(data: unknown, mimeType: unknown): string | null {
  if (!isMimeType(mimeType)) return `mimeType must be one of ${Object.keys(SIGNATURES).join(', ')}`;
  if (typeof data !== 'string') return 'data must be a base64 string';
  if (data.length > BRIDGE_IMAGE_LIMITS.maxImageBytes) {
    return `image is ${data.length} base64 characters; the limit is ${BRIDGE_IMAGE_LIMITS.maxImageBytes}`;
  }
  if (data.length < 16 || data.length % 4 !== 0 || !BASE64.test(data)
    || (data.endsWith('=') && !BASE64_PADDING.test(data.slice(-3)))) {
    return 'data must be canonical base64 of an image file';
  }
  // 16 characters decode to 12 bytes, enough for every signature above.
  const head = atob(data.slice(0, 16));
  const signature = SIGNATURES[mimeType];
  if (signature.some((byte, i) => byte !== null && head.charCodeAt(i) !== byte)) {
    return `data does not start with the ${mimeType} file signature`;
  }
  return null;
}

/** Check a result's `content` array and copy out only the protocol fields. */
export function validateResultContent(raw: unknown): { ok: true; value: BridgeContent[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'result.content must be an array' };
  const value: BridgeContent[] = [];
  let images = 0;
  for (const [i, c] of raw.entries()) {
    if (isRecord(c) && c.type === 'text' && typeof c.text === 'string') {
      value.push({ type: 'text', text: c.text });
    } else if (isRecord(c) && c.type === 'image') {
      if (++images > BRIDGE_IMAGE_LIMITS.maxImagesPerResult) {
        return { ok: false, error: `at most ${BRIDGE_IMAGE_LIMITS.maxImagesPerResult} images per result` };
      }
      const error = imageContentError(c.data, c.mimeType);
      if (error) return { ok: false, error: `result.content[${i}]: ${error}` };
      value.push({ type: 'image', data: c.data as string, mimeType: c.mimeType as BridgeImageMimeType });
    } else {
      return {
        ok: false,
        error: `result.content[${i}] must be {type: 'text', text} or {type: 'image', data, mimeType}; the bridge accepts text and image content only`,
      };
    }
  }
  return { ok: true, value };
}
