// SPDX-License-Identifier: MPL-2.0
import { expect, type Page } from '@playwright/test';
import { decodePng, rendererColorFrame } from './federation-control-triplet.rendering';
import type { SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';

/** #7955: the unstyled proxy fixture is neutral grey. Sample renderer-owned
 * pixels at actual occurrence centres, excluding transparent canvas background.
 * This is a colour-region witness, not a draw-call or compositor witness. */
export async function mappedInstancePixels(page: Page) {
  const centres = await page.evaluate(() => {
    const host = globalThis as typeof globalThis & { __ifc_lite_scene_owner__: (id: number) => SceneOwnerSnapshot };
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    if (!canvas) throw new Error('Main viewport canvas missing');
    const rect = canvas.getBoundingClientRect();
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      points: Array.from({ length: 64 }, (_, i) => host.__ifc_lite_scene_owner__(31 + 7 * i).screen).filter(p => p !== null) };
  });
  const png = await rendererColorFrame(page), frame = decodePng(png);
  const pixels = new Set<number>();let colouredOwners = 0;
  for (const point of centres.points) {
    const cx = Math.round((point.x - centres.rect.x) * frame.width / centres.rect.width);
    const cy = Math.round((point.y - centres.rect.y) * frame.height / centres.rect.height);
    let coloured = false;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const offset = (y * frame.width + x) * 4;
      const [r, g, b, a] = frame.rgba.subarray(offset, offset + 4);
      // Lighting changes brightness; the source's neutral-grey region stays
      // neutral. Bounds exclude white UI/background and fully black lines.
      if (a >= 250 && r >= 50 && r <= 240 && Math.max(r,g,b) - Math.min(r,g,b) <= 25) {
        pixels.add(offset);coloured = true;
      }
    }
    if (coloured) colouredOwners++;
  }
  expect(colouredOwners, 'neutral-grey geometry at four projected occurrence centres').toBeGreaterThanOrEqual(4);
  expect(pixels.size, 'opaque nonblank renderer-owned pixels in expected colour regions').toBeGreaterThanOrEqual(16);
  return { png, evidence: { colouredOwners, regionPixels: pixels.size, frameWidth: frame.width, frameHeight: frame.height } };
}
