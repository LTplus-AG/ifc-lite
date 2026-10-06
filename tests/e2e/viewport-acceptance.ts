/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, type Page, type TestInfo } from '@playwright/test';
import { decodePng } from './federation-control-triplet.rendering';
import { GPU_STRICT, type GpuDeviceLossWatch } from './gpu-device-loss';
import { classifyViewportWitness, type RgbaFrame, type ViewportWitness } from './viewport-witness';

async function readbackFrame(page: Page): Promise<RgbaFrame | null> {
  const dataUrl = await page.evaluate(async () => globalThis.__ifc_lite_capture_color_frame__?.() ?? null).catch(() => null);
  const encoded = dataUrl?.match(/^data:image\/png;base64,(.+)$/);
  return encoded ? decodePng(Buffer.from(encoded[1]!, 'base64')) : null;
}

/**
 * Record whether the 3D viewport really rendered the model (#6858). Polls the
 * renderer colour readback, attaches the verdict (and the frame when present)
 * to the test, and fails unless the model rendered or a hosted software-GPU
 * device loss makes geometry acceptance explicitly "not established". It never
 * skips: the recording's panel assertions stay valid, geometry claims do not.
 */
export async function recordViewportWitness(page: Page, watch: GpuDeviceLossWatch, testInfo: TestInfo, label: string): Promise<ViewportWitness> {
  let frame: RgbaFrame | null = null;
  let verdict = classifyViewportWitness({ frame, lossEvidence: null, strict: GPU_STRICT });
  await expect.poll(async () => {
    frame = await readbackFrame(page);
    verdict = classifyViewportWitness({ frame, lossEvidence: await watch.lost(), strict: GPU_STRICT });
    return verdict.status;
  }, { timeout: 30_000, message: 'viewport witness' }).not.toBe('fail').catch(() => undefined);
  testInfo.annotations.push({ type: `viewport-witness:${label}`, description: `${verdict.status}: ${verdict.summary}` });
  expect(verdict.status, verdict.summary).not.toBe('fail');
  return verdict;
}
