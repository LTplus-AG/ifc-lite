/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Production screenshot readback helpers for the #5049 hardware witness. */

export type Rgba = [number, number, number, number];

async function screenshotImage(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

/**
 * Samples a Renderer-produced PNG; it never reads the WebGPU canvas directly.
 * Keeping the sample outside the renderer also makes the report inspectable
 * from a Playwright artifact on the machine that owns the hardware adapter.
 */
export async function screenshotPixel(dataUrl: string | null, x: number, y: number): Promise<Rgba | null> {
  if (!dataUrl) return null;
  const bitmap = await screenshotImage(dataUrl);
  const probe = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = probe.getContext('2d');
  if (!context) throw new Error('2D screenshot probe context is unavailable.');
  context.drawImage(bitmap, 0, 0);
  const pixel = context.getImageData(x, y, 1, 1).data;
  bitmap.close();
  return [pixel[0], pixel[1], pixel[2], pixel[3]];
}

/** Actual framebuffer evidence, rather than a renderer draw counter. */
export async function screenshotDifference(before: string | null, after: string | null): Promise<{ changedPixels: number; maxChannelDelta: number } | null> {
  if (!before || !after) return null;
  const [beforeImage, afterImage] = await Promise.all([screenshotImage(before), screenshotImage(after)]);
  if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
    beforeImage.close();
    afterImage.close();
    throw new Error('Renderer screenshot dimensions changed during a witness observation.');
  }
  const probe = new OffscreenCanvas(beforeImage.width, beforeImage.height);
  const context = probe.getContext('2d');
  if (!context) throw new Error('2D screenshot probe context is unavailable.');
  context.drawImage(beforeImage, 0, 0);
  const beforePixels = context.getImageData(0, 0, probe.width, probe.height).data;
  context.clearRect(0, 0, probe.width, probe.height);
  context.drawImage(afterImage, 0, 0);
  const afterPixels = context.getImageData(0, 0, probe.width, probe.height).data;
  beforeImage.close();
  afterImage.close();
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < beforePixels.length; index += 4) {
    const delta = Math.max(
      Math.abs(beforePixels[index] - afterPixels[index]),
      Math.abs(beforePixels[index + 1] - afterPixels[index + 1]),
      Math.abs(beforePixels[index + 2] - afterPixels[index + 2]),
    );
    if (delta > 1) changedPixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  return { changedPixels, maxChannelDelta };
}

export function isForeground(pixel: Rgba | null, clear = 5): boolean {
  return pixel !== null && Math.max(Math.abs(pixel[0] - clear), Math.abs(pixel[1] - clear), Math.abs(pixel[2] - clear)) > 8;
}
