/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_screenshot`: what the agent's user sees in the viewport, as an
 * image the agent can look at. Captured by the same native producer as
 * `exports.screenshot` (`operations/native-viewport-frame.ts`), downscaled
 * and encoded inside the capture's synchronous read, and returned inline
 * rather than as an artifact. Read-only: it changes neither the model nor
 * the view.
 */

import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { fail, integer, keys, oneOf } from './tool-args';
import { BRIDGE_LIMITS } from '@ifc-lite/mcp/bridge-protocol';
import type { ViewCameraSnapshot } from '@/lib/export/view-pdf/generate-view-pdf';
import { assertDispatchActive } from './cancellation';
import type { AgentInputSchema, ModelFreeTool, ToolOutput } from './types';

/** First opaque background behind the viewport canvas, or null outside a DOM. */
function viewportBackground(canvas: HTMLCanvasElement): string | null {
  if (typeof getComputedStyle !== 'function') return null;
  for (let el: Element | null = canvas; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return null;
}
export const SCREENSHOT_WIDTH = { min: 256, max: 1920, default: 1024 } as const;
const JPEG_QUALITY = 0.8;

export const SCREENSHOT_SPECS = {
  viewer_screenshot: {
    description: 'Capture the 3D viewport as the user currently sees it (camera, visibility, section cuts, selection highlight) and return it as an image. '
      + `Downscaled to max_width pixels wide (${SCREENSHOT_WIDTH.min}-${SCREENSHOT_WIDTH.max}, default ${SCREENSHOT_WIDTH.default}), aspect kept; JPEG by default, PNG on request. `
      + 'Does not change the model or the view. Fails when no viewport is mounted.',
    inputSchema: { type: 'object', properties: {
      max_width: { type: 'integer', minimum: SCREENSHOT_WIDTH.min, maximum: SCREENSHOT_WIDTH.max, default: SCREENSHOT_WIDTH.default },
      format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
    } } satisfies AgentInputSchema,
    readOnly: true,
  },
} as const;

/** What the tool needs from the live viewer; replaced in tests. */
export interface ScreenshotDeps {
  /** The native capture: renders one owned frame and returns what `read` serialised, or null on failure. */
  capture(read: (canvas: HTMLCanvasElement) => string, signal?: AbortSignal): Promise<string | null>;
  /** The camera of the frame being read (called inside `read`). */
  camera(): ViewCameraSnapshot | null;
  createCanvas(): HTMLCanvasElement;
}

async function nativeDeps(): Promise<ScreenshotDeps> {
  const [{ captureNativeViewport }, { readCameraSnapshot }] = await Promise.all([
    import('./operations/native-viewport-frame'),
    import('@/lib/export/view-pdf/view-pdf-export-source'),
  ]);
  return { capture: captureNativeViewport, camera: readCameraSnapshot, createCanvas: () => document.createElement('canvas') };
}

/** `width` x `height` scaled down to at most `maxWidth` wide, aspect kept; never scaled up. */
export function fitWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round(height * (maxWidth / width))) };
}

function parseArgs(args: Record<string, unknown>): { maxWidth: number; mimeType: 'image/jpeg' | 'image/png' } {
  keys(args, ['max_width', 'format']);
  const maxWidth = integer(args, 'max_width', SCREENSHOT_WIDTH.default, SCREENSHOT_WIDTH.min, SCREENSHOT_WIDTH.max);
  return { maxWidth, mimeType: oneOf(args, 'format', ['jpeg', 'png'] as const, 'jpeg') === 'png' ? 'image/png' : 'image/jpeg' };
}

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,/;
const round = (v: number) => Math.round(v * 100) / 100;

export function createScreenshotTool(load: () => Promise<ScreenshotDeps> = nativeDeps): ModelFreeTool {
  return { needs: 'none', async run(_host, args, ctx): Promise<ToolOutput> {
    const { maxWidth, mimeType } = parseArgs(args);
    const deps = await load();
    assertDispatchActive(ctx.signal);
    // Filled inside the capture's synchronous read, where the frame and its camera are current.
    const frame = { source: { width: 0, height: 0 }, size: { width: 0, height: 0 }, camera: null as ViewCameraSnapshot | null };
    let url: string | null;
    try {
      url = await deps.capture((canvas) => {
        frame.source = { width: canvas.width, height: canvas.height };
        if (!canvas.width || !canvas.height) throw new Error('The viewport canvas has no size.');
        frame.size = fitWidth(canvas.width, canvas.height, maxWidth);
        const out = deps.createCanvas();
        out.width = frame.size.width;
        out.height = frame.size.height;
        const g = out.getContext('2d');
        if (!g) throw new Error('No 2D canvas context to scale the capture.');
        // The viewport clears to transparent (e.g. under the map overlay); JPEG would turn that black.
        const background = viewportBackground(canvas);
        if (background) { g.fillStyle = background; g.fillRect(0, 0, frame.size.width, frame.size.height); }
        g.drawImage(canvas, 0, 0, frame.size.width, frame.size.height);
        frame.camera = deps.camera();
        return out.toDataURL(mimeType, JPEG_QUALITY);
      }, ctx.signal);
    } catch (err) {
      fail(ToolErrorCode.UNSUPPORTED_OPERATION, `No viewport to capture: ${err instanceof Error ? err.message : String(err)}`,
        'Ask the user to open a model in the viewer tab so the 3D viewport is showing, then retry.');
    }
    assertDispatchActive(ctx.signal);
    // The browser may fall back to PNG for an unsupported type: report what was actually encoded.
    const match = url ? DATA_URL.exec(url) : null;
    if (!url || !match) {
      // The capture service reports a missing or unready viewport as no image.
      fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'The viewport capture produced no image.',
        'Make sure a model is open and the 3D viewport is showing in the viewer tab, then retry.');
    }
    const data = url.slice(match[0].length);
    const encoded = match[1] as 'image/png' | 'image/jpeg';
    const { source, size, camera: cam } = frame;
    if (data.length > BRIDGE_LIMITS.maxImageBytes) {
      fail(ToolErrorCode.INVALID_INPUT, `The ${size.width}x${size.height} capture is ${data.length} base64 characters; the limit is ${BRIDGE_LIMITS.maxImageBytes}.`,
        "Retry with format 'jpeg' or a smaller max_width.");
    }
    const structured = {
      width: size.width, height: size.height, source_width: source.width, source_height: source.height, mime_type: encoded,
      ...(cam ? { camera: { projection: cam.projectionMode, position: cam.position, target: cam.target } } : {}),
    };
    const at = cam ? `; ${cam.projectionMode} camera at (${[cam.position.x, cam.position.y, cam.position.z].map(round).join(', ')}) looking at (${[cam.target.x, cam.target.y, cam.target.z].map(round).join(', ')})` : '';
    return {
      text: `Viewport screenshot, ${size.width}x${size.height} ${encoded} (viewport ${source.width}x${source.height})${at}.`,
      structured,
      image: { data, mimeType: encoded },
    };
  } };
}

export const screenshotTools = { viewer_screenshot: createScreenshotTool() } satisfies Record<keyof typeof SCREENSHOT_SPECS, ModelFreeTool>;
