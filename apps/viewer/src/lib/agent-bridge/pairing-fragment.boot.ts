/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Side-effect import for `bootstrap.tsx`: strip a pairing link's fragment at first load (#9523). */
import { takePairingFragment } from './pairing-fragment';

if (typeof window !== 'undefined') takePairingFragment(window.location, window.history);
