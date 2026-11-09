/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared active state (#8802 R4) for a "this is on" control that cannot be
 * a `Button variant="toggle"`: a wizard's current step, a radio label, a chip
 * that is not a button. Primary-tinted surface, active ink, 1px inset active
 * edge. Apply it by flag; the solid primary fill stays reserved for a panel's
 * one next action (#8802 R5).
 */
export const ACTIVE_STATE_CLASS = 'bg-active-surface text-active ring-1 ring-inset ring-active-border';

/** The same state on a control that already draws a 1px border: the border
 *  itself becomes the active edge, so the edge is not doubled. */
export const ACTIVE_BORDERED_STATE_CLASS = 'border-active-border bg-active-surface text-active';

/**
 * The same state on a Radix tab trigger. `!important` because the dark theme's
 * global `[data-state="active"]` reset in index.css is itself `!important`; a
 * layered important utility wins over that unlayered rule.
 */
export const ACTIVE_TAB_CLASS =
  'data-[state=active]:!bg-active-surface data-[state=active]:!text-active data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-active-border';
