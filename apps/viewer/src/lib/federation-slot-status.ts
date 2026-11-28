/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which slots of a configured federation (`open.federation`) failed, why, and
 * how to try each again. The model list reads it to offer Retry on the failed
 * model's own row: the viewer's load card holds one error at a time and is
 * cleared when the next model starts, so it cannot be a slot's only Retry.
 *
 * Keyed by model id, which for a federation slot is its slot id.
 */

import { useSyncExternalStore } from 'react';

export interface FederationSlotFailure {
  /** The message the model's record also carries as `loadError`. */
  reason: string;
  /** Loads this slot again, through the same path as the first attempt. */
  retry: () => void;
}

const failures = new Map<string, FederationSlotFailure>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of Array.from(listeners)) listener(); };

export function setFederationSlotFailure(modelId: string, failure: FederationSlotFailure | null): void {
  if (failure) failures.set(modelId, failure);
  else if (!failures.delete(modelId)) return;
  notify();
}

/** Forget every slot's failure: a new federation (or none) replaces the old one. */
export function clearFederationSlotFailures(): void {
  if (failures.size === 0) return;
  failures.clear();
  notify();
}

export function federationSlotFailure(modelId: string): FederationSlotFailure | undefined {
  return failures.get(modelId);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useFederationSlotFailure(modelId: string): FederationSlotFailure | undefined {
  return useSyncExternalStore(subscribe, () => failures.get(modelId), () => undefined);
}
