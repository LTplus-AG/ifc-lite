/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Truthful 3D-viewport verdict for acceptance recordings (#6858).
 *
 * Hosted CI runs Chrome on SwiftShader WebGPU: the device can be dropped by
 * Dawn mid-run, and even a healthy software canvas is blank in compositor
 * screenshots and videos. Panel and CPU assertions still pass in that state,
 * so a recording of it must not read as geometry acceptance. Only a
 * renderer colour readback (not the compositor) can witness the model.
 */

/** Fraction of the readback that must differ from the background to count as geometry. */
export const MIN_GEOMETRY_FRACTION = 0.01;

const CHANNEL_TOLERANCE = 8;

export interface RgbaFrame { width: number; height: number; rgba: Uint8Array }

export interface ViewportWitnessInput {
  /** Renderer colour readback, or null when none could be captured. */
  frame: RgbaFrame | null;
  /** First device-loss console/toast evidence the page produced, if any. */
  lossEvidence: string | null;
  /** `E2E_GPU_STRICT !== '0'`: a real GPU, where nothing may be waived. */
  strict: boolean;
}

export interface ViewportWitness {
  status: 'rendered' | 'not-established' | 'fail';
  geometryPixels: number;
  summary: string;
}

/** Pixels differing from the top-left background colour by more than a small tolerance. */
function geometryPixels({ rgba }: RgbaFrame): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (Math.abs(rgba[i]! - rgba[0]!) > CHANNEL_TOLERANCE
      || Math.abs(rgba[i + 1]! - rgba[1]!) > CHANNEL_TOLERANCE
      || Math.abs(rgba[i + 2]! - rgba[2]!) > CHANNEL_TOLERANCE) count++;
  }
  return count;
}

export function classifyViewportWitness({ frame, lossEvidence, strict }: ViewportWitnessInput): ViewportWitness {
  const pixels = frame ? geometryPixels(frame) : 0;
  if (frame && pixels >= frame.width * frame.height * MIN_GEOMETRY_FRACTION) {
    const recovered = lossEvidence ? ` (the GPU device was lost and recovered: ${lossEvidence})` : '';
    return { status: 'rendered', geometryPixels: pixels, summary: `Renderer readback shows ${pixels} geometry pixels${recovered}.` };
  }
  if (lossEvidence !== null && !strict) {
    return {
      status: 'not-established',
      geometryPixels: pixels,
      summary: `This is NOT geometry acceptance: the software WebGPU device lost and did not render (${lossEvidence}). `
        + 'Panel and CPU assertions in this recording remain valid; the viewport footage does not prove the model rendered.',
    };
  }
  const why = frame ? `only ${pixels} geometry pixels` : 'no renderer readback was available';
  return {
    status: 'fail',
    geometryPixels: pixels,
    summary: `Viewport did not render the model: ${why}${lossEvidence ? `; device loss: ${lossEvidence}` : ''}.`,
  };
}
