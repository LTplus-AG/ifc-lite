/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Viewport Segments API (Chrome 138+): `window.viewport.segments` lists the
 * window's regions either side of a fold or hinge, or null / one segment when
 * it spans none. The TypeScript DOM lib does not ship it yet; declared here as
 * optional, and read only behind a runtime check (`useMobileLayoutMode`).
 */

interface ViewportSegmentsApi {
  readonly segments: ReadonlyArray<DOMRectReadOnly> | null;
}

interface Window {
  readonly viewport?: ViewportSegmentsApi;
}
