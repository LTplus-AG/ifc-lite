/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Side-effect import for `bootstrap.tsx` (#9523): strip a pairing link's
 * fragment at first load, and whenever one arrives later in the same document
 * (the link opened in the tab that already holds the model).
 *
 * A same-document fragment navigation fires `popstate` and then `hashchange`.
 * Both are registered here, at boot, before any other module adds listeners,
 * and in the capture phase, which for events targeted at `window` runs before
 * non-capture listeners: the router and analytics see the stripped URL.
 * Nothing here forwards the URL anywhere.
 */
import { installPairingFragmentStrip } from './pairing-fragment';

installPairingFragmentStrip();
