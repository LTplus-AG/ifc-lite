/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A text link or link-styled action in viewer chrome (#8802 R5). Links carry
 * no hue: colour is reserved for meaning (selection, status, IFC class, clash
 * A/B). A link stays identifiable by its underline, which is quiet at rest
 * and turns to full ink on hover.
 */
export const TEXT_LINK_CLASS =
  'text-foreground underline decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground';
