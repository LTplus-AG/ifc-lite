/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stub for the optional `y-webrtc` transport.
 *
 * `@ifc-lite/collab` ships a WebRTC provider that lazily `import('y-webrtc')`
 * with a runtime fallback. The viewer only uses the indexeddb+websocket
 * transport and never instantiates `WebrtcProvider`, so y-webrtc isn't a
 * dependency. The production build marks it `external` (see vite.config
 * `rollupOptions.external`), but Vite's dev import-analysis still tries to
 * resolve the bare specifier and fails — which makes `import('@ifc-lite/collab')`
 * reject and silently disables collab in dev. Aliasing `y-webrtc` to this stub
 * keeps the specifier resolvable in both dev and build; the WebRTC code path is
 * never executed in the viewer.
 */

export class WebrtcProvider {
  constructor() {
    throw new Error(
      '@ifc-lite/collab: the WebRTC transport is not available in the viewer build (y-webrtc is stubbed).',
    );
  }
}

export default { WebrtcProvider };
