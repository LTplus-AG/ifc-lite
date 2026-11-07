/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the phone layout's bottom controls sit, in one place: the Home/zoom
 * pill on the left (`ViewportOverlays`) and the Panels button on the right
 * (`MobilePanelLauncher`) share this offset from the viewport's bottom, so
 * the two read as one row instead of two unrelated floats.
 *
 * A share of the height rather than a fixed inset: it keeps both clear of the
 * iOS Safari URL bar overlay, which takes the bottom of the visual viewport.
 */
export const MOBILE_NAV_BOTTOM = '15%';
