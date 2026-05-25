/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pre-React theme bootstrap. Lives at /theme-bootstrap.js (same origin) so the
 * deployed CSP `script-src 'self' 'wasm-unsafe-eval' blob:` allows it — an inline
 * <script> would need 'unsafe-inline' or a nonce, neither of which the embed
 * deploy currently grants. Runs synchronously in <head> before React mounts so
 * there's no flash on `?theme=dark`. The .light class is already on <html> in
 * the static markup, so a complete failure here still ships a light embed.
 */
(function () {
  try {
    var p = new URLSearchParams(location.search);
    var t = p.get('theme');
    var root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(t === 'dark' ? 'dark' : 'light');
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[ifc-lite-embed] theme bootstrap failed; falling back to light:', e);
    }
  }
})();
