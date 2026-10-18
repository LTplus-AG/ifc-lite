/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { RendererRecoveryHost } from './device-recovery.js';

/** Requested policy survives replacement; successful device admission does not.
 * #7655: the pipeline can finish before teardown but publish after a new init or
 * loss has already revoked its ownership. Keep that fence at the caller too. */
export async function enableRendererQuantizedBatches(host: RendererRecoveryHost): Promise<boolean> {
  host.recovery.quantizedBatchesRequested = true;
  const pipeline = host.pipeline;
  const generation = host.initGeneration;
  const lossSequence = host.deviceLossSequence;
  if (!pipeline || host.destroyed || host.deviceLost) return false;
  const ok = await pipeline.ensureQuantizedPipelines();
  if (host.pipeline !== pipeline || host.initGeneration !== generation
    || host.deviceLossSequence !== lossSequence || host.destroyed || host.deviceLost) return false;
  if (ok) host.scene.setQuantizedBatches(true);
  return ok;
}
