/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store state for a test that wants the phone or the desktop layout (#9718).
 *
 * `isMobile` is derived from `formFactor` (`setFormFactor` writes both), and
 * components read either one. Seeding `isMobile` alone left `formFactor` on the
 * desktop default, so a "phone" test rendered desktop placements wherever a
 * component reads the form factor. Spread this instead: `setState({ ...formFactorState(true) })`.
 */

import { classifyFormFactor, DESKTOP_FORM_FACTOR, type FormFactor } from '@/lib/layout/form-factor';

/** A portrait phone, 390x844 with a touch screen. */
export const PHONE_FORM_FACTOR: FormFactor = classifyFormFactor({ width: 390, height: 844, coarsePointer: true });

export function formFactorState(mobile: boolean): { formFactor: FormFactor; isMobile: boolean } {
  return { formFactor: mobile ? PHONE_FORM_FACTOR : DESKTOP_FORM_FACTOR, isMobile: mobile };
}
