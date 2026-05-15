/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clipboard sniffing for the BYOK key modal.
 *
 * After the user clicks our "Open Console" button, they create a key on the
 * provider's site, copy it, and return to this tab. If transient activation
 * (or clipboard-read permission) is still valid, we can detect the key and
 * offer one-click insertion instead of forcing a manual paste.
 *
 * Reads are best-effort and silently no-op on:
 *   - missing Clipboard API (older Safari, insecure context, sandboxed iframe)
 *   - permission denied (Firefox without explicit user grant)
 *   - read failure for any other reason
 *
 * We never throw on these — the modal just falls back to its manual paste UX.
 */

export type BYOKProvider = 'anthropic' | 'openai';

/**
 * Provider-specific shape checks. Tight enough to avoid false positives on
 * random clipboard contents, permissive enough to cover the key formats each
 * provider currently issues.
 *
 *   Anthropic console keys: `sk-ant-api03-` + ≥50 chars of [A-Za-z0-9_-]
 *   OpenAI keys:            `sk-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-` + ≥20 chars
 *
 * The OpenAI pattern uses a negative lookahead for `ant-` so an Anthropic key
 * doesn't accidentally satisfy the OpenAI tab — they both start with `sk-`.
 */
const PROVIDER_PATTERNS: Record<BYOKProvider, RegExp> = {
  anthropic: /^sk-ant-api03-[A-Za-z0-9_-]{50,}$/,
  openai: /^sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/,
};

/**
 * Try to read a candidate provider key from the system clipboard.
 *
 * Returns the trimmed key string if the clipboard contents match the provider
 * pattern. Returns `null` for everything else (no match, permission denied,
 * Clipboard API unavailable, etc.) — callers should treat `null` as "fall back
 * to manual paste".
 */
export async function readClipboardKey(provider: BYOKProvider): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    return null;
  }
  try {
    const text = await navigator.clipboard.readText();
    const trimmed = text.trim();
    if (PROVIDER_PATTERNS[provider].test(trimmed)) {
      return trimmed;
    }
    return null;
  } catch {
    /* clipboard read denied / insecure context — safe to ignore, manual paste still works */
    return null;
  }
}

/**
 * Render-safe key mask. Preserves the provider prefix so the user can confirm
 * the right key is detected, hides the secret middle, shows the last 4 chars
 * for disambiguation.
 *
 *   sk-ant-api03-abcdef…XYZA
 *   sk-proj-••••XYZA
 *   sk-••••XYZA
 */
export function maskKey(key: string): string {
  if (key.length < 12) return '••••';
  const dashIdx = key.lastIndexOf('-');
  const prefixEnd = dashIdx > 0 && dashIdx < 14 ? dashIdx + 1 : Math.min(14, key.length - 4);
  return `${key.slice(0, prefixEnd)}••••${key.slice(-4)}`;
}

/**
 * Light shape check shared with `readClipboardKey` so callers can validate
 * manual paste contents the same way before saving.
 */
export function looksLikeProviderKey(provider: BYOKProvider, value: string): boolean {
  return PROVIDER_PATTERNS[provider].test(value.trim());
}
