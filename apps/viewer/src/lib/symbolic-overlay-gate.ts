/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether each symbolic 2D overlay channel draws, once the host's `hideTypes`
 * is taken into account (issue #2934).
 *
 * `IfcAnnotation` 2D content never becomes a mesh: Rust routes every
 * `Plan | Annotation | FootPrint | Axis` representation into symbolic data
 * (`rust/processing/src/symbolic/mod.rs`), which the viewport draws as a
 * line-and-text overlay. `IfcGridAxis` takes the same route and got its own
 * channel in #862. A host-level class hide that filters the MESH list — which
 * is all `hideTypes` did — could never reach either one, so a host naming
 * `IfcAnnotation` got silence and no error.
 *
 * ## Channel-level, and honest about it
 *
 * The gate switches whole CHANNELS while `hideTypes` names CLASSES. Those are
 * the same thing here, and only because of what the overlay carries: the
 * `'overlay'` flatten filter keeps exactly the owner classes in
 * `OVERLAY_CHANNEL_OWNER_TYPES`, one per channel, so "the annotation channel"
 * and "`IfcAnnotation`" have the same members. It is NOT the case for the 2D
 * drawing (`useDrawingGeneration`), which parses with mode `'all'` and does
 * draw a wall's `Axis` and a space's `FootPrint` — and which this gate
 * deliberately does not touch.
 *
 * Should a channel ever gain a second owner class, the loop below keeps the
 * gate honest rather than over-hiding: it switches a channel off only when
 * EVERY class that channel draws is hidden, so hiding one of two classes can
 * never take the other's content with it.
 */

import {
  OVERLAY_CHANNEL_OWNER_TYPES,
  type OverlayChannel,
} from './overlay-parse/overlay-channels.js';
import { isIfcTypeHiddenByHost } from './host-hidden-ifc-types.js';

/** One boolean per overlay channel — the store toggles going in, the drawing
 *  decision coming out. */
export type SymbolicOverlayChannelGate = Record<OverlayChannel, boolean>;

const CHANNEL_OWNERS = Object.entries(OVERLAY_CHANNEL_OWNER_TYPES) as ReadonlyArray<
  readonly [OverlayChannel, readonly string[]]
>;

/**
 * Combine the store's per-channel toggles with the host's hidden class set.
 *
 * Both apply: a class named in `hideTypes` stays hidden when a later
 * `SET_TYPE_VISIBILITY` turns its toggle on, exactly as a hidden `IfcSpace`
 * mesh behaves today.
 */
export function symbolicOverlayGate(
  toggles: SymbolicOverlayChannelGate,
  hostHiddenIfcTypes: ReadonlySet<string> | null | undefined,
): SymbolicOverlayChannelGate {
  const gate = {} as SymbolicOverlayChannelGate;
  for (const [channel, ownerTypes] of CHANNEL_OWNERS) {
    gate[channel] =
      toggles[channel] && ownerTypes.some((t) => !isIfcTypeHiddenByHost(t, hostHiddenIfcTypes));
  }
  return gate;
}
