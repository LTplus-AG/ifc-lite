/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Read the producing offscreen texture rather than a presentation buffer that
// the compositor can discard before automation takes its screenshot.
export async function captureTexture(device, texture, width, height) {
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) pixels.set(source.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
    const sampledColors = new Set();
    for (let i = 0; i < pixels.length; i += 4 * 17) sampledColors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
    copy.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    const middle = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    return { png: copy.toDataURL(), sampledColors: sampledColors.size, centerPixel: Array.from(pixels.subarray(middle, middle + 4)) };
  } finally { buffer.destroy(); }
}
