/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host hook for finished clash runs: a host that stores runs per
 * coordination round registers a listener through `ViewerHandle` and receives
 * each completed run as a `ClashRunDocument`. Nothing is built, sent or stored
 * unless a listener is registered; the viewer itself has no network code here.
 *
 * Type-only import of `@ifc-lite/clash`, so registering from the entry chunk
 * does not pull the clash engine in. The document is built by
 * `host-run-document.ts`, which only the clash chunk imports.
 */

import type { ClashRunDocument } from '@ifc-lite/clash';

/** The slot a loaded model occupies, as the host pinned it. */
export interface ClashRunHostSlot {
  slot: string;
  /** Hex sha256 of the exact model version, or null when the host does not pin one. */
  sha256: string | null;
  label?: string;
}

export interface ClashRunCompleteEvent {
  document: ClashRunDocument;
}

/** Its return value is ignored, except that a returned promise's rejection is logged, never left unhandled. */
export type ClashRunCompleteListener = (event: ClashRunCompleteEvent) => unknown;

export interface ClashRunListenerOptions {
  /**
   * Map a loaded model to its slot. Returning null (or omitting the option)
   * keys the model by its per-load id with no pinned version, which a later
   * comparison treats as unpinned.
   */
  resolveSlot?: (model: { id: string; name: string }) => ClashRunHostSlot | null;
  /** Host-pinned rule revisions by rule id (e.g. a saved rule-set version). */
  ruleRevisions?: Readonly<Record<string, string>>;
}

interface Registration {
  listener: ClashRunCompleteListener;
  options: ClashRunListenerOptions;
}

const registrations = new Set<Registration>();

/** Register a listener for completed clash runs. Returns its unsubscribe. */
export function onClashRunComplete(listener: ClashRunCompleteListener, options: ClashRunListenerOptions = {}): () => void {
  const registration: Registration = { listener, options };
  registrations.add(registration);
  return () => { registrations.delete(registration); };
}

/** The current registrations; empty when no host listens. */
export function clashRunRegistrations(): readonly Registration[] {
  return [...registrations];
}
