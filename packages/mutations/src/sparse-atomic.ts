// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { cooperativeOverlay } from './cooperative-overlay-access.js';
import { sparseOverlay } from './sparse-overlay.js';
import { withoutEntityExposure } from './entity-read-barrier.js';
import type { MutablePropertyView } from './mutable-property-view.js';

export function runSparseAtomic<T>(view: MutablePropertyView, edit: (draft: MutablePropertyView) => T, record: boolean) {
  const access = cooperativeOverlay(view), revision = view.getMutationRevision();
  const transaction = sparseOverlay(access.capture());
  const draft = access.draft({ ...transaction.state });
  const result = edit(draft);
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
    && 'then' in result && typeof result.then === 'function') {
    void Promise.resolve(result).catch(error => console.error('Discarded asynchronous overlay transaction failed', error));
    throw new TypeError('Overlay transactions must be synchronous; prepare asynchronous work before editing');
  }
  if (view.getMutationRevision() !== revision) throw new Error('The IFC overlay changed during a prepared transaction.');
  const prepared = withoutEntityExposure(() => transaction.finish(cooperativeOverlay(draft).capture(), record));
  if (record && prepared.changed && !prepared.written.length) throw new Error('A compound edit must record its mutations');
  access.publish(prepared.publish());
  return { result, inverse: prepared.inverse, written: prepared.written };
}
