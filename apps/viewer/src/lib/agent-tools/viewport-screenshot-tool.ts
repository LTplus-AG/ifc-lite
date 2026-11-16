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

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { BRIDGE_LIMITS } from '@ifc-lite/mcp/bridge-protocol';
import type { ViewCameraSnapshot } from '@/lib/export/view-pdf/generate-view-pdf';
import { assertDispatchActive } from './cancellation';
import type { AgentInputSchema, ModelFreeTool, ToolOutput } from './types';

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
  capture(read: (canvas: HTMLCanvasElement) => string): Promise<string | null>;
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

function invalid(message: string): never {
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

function parseArgs(args: Record<string, unknown>): { maxWidth: number; mimeType: 'image/jpeg' | 'image/png' } {
  if (Object.keys(args).some((key) => key !== 'max_width' && key !== 'format')) invalid('Unknown argument. Use max_width and format only.');
  const maxWidth = args.max_width ?? SCREENSHOT_WIDTH.default;
  if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < SCREENSHOT_WIDTH.min || maxWidth > SCREENSHOT_WIDTH.max) {
    invalid(`max_width must be an integer from ${SCREENSHOT_WIDTH.min} to ${SCREENSHOT_WIDTH.max}.`);
  }
  const format = args.format ?? 'jpeg';
  if (format !== 'jpeg' && format !== 'png') invalid("format must be 'jpeg' or 'png'.");
  return { maxWidth, mimeType: format === 'png' ? 'image/png' : 'image/jpeg' };
}

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,/;
const round = (v: number) => Math.round(v * 100) / 100;

export function createScreenshotTool(load: () => Promise<ScreenshotDeps> = nativeDeps): ModelFreeTool {
  return { needs: 'none', async run(_host, args, ctx): Promise<ToolOutput> {
    const { maxWidth, mimeType } = parseArgs(args);
    const deps = await load();
    assertDispatchActive(ctx.signal);
    let source = { width: 0, height: 0 };
    let size = source;
    let camera: ViewCameraSnapshot | null = null;
    let url: string | null;
    try {
      url = await deps.capture((canvas) => {
        source = { width: canvas.width, height: canvas.height };
        if (!source.width || !source.height) throw new Error('The viewport canvas has no size.');
        size = fitWidth(source.width, source.height, maxWidth);
        const out = deps.createCanvas();
        out.width = size.width;
        out.height = size.height;
        const g = out.getContext('2d');
        if (!g) throw new Error('No 2D canvas context to scale the capture.');
        g.drawImage(canvas, 0, 0, size.width, size.height);
        camera = deps.camera();
        return out.toDataURL(mimeType, JPEG_QUALITY);
      });
    } catch (err) {
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `No viewport to capture: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'Ask the user to open a model in the viewer tab so the 3D viewport is showing, then retry.',
      });
    }
    assertDispatchActive(ctx.signal);
    const match = url ? DATA_URL.exec(url) : null;
    if (!url || !match) {
      throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'The viewport capture produced no image.', hint: 'Retry once the view has finished rendering.' });
    }
    const data = url.slice(match[0].length);
    if (data.length > BRIDGE_LIMITS.maxImageBytes) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `The ${size.width}x${size.height} capture is ${data.length} base64 characters; the limit is ${BRIDGE_LIMITS.maxImageBytes}.`,
        hint: "Retry with format 'jpeg' or a smaller max_width.",
      });
    }
    const cam = camera as ViewCameraSnapshot | null;
    const structured = {
      width: size.width, height: size.height, source_width: source.width, source_height: source.height, mime_type: match[1],
      ...(cam ? { camera: { projection: cam.projectionMode, position: cam.position, target: cam.target } } : {}),
    };
    const at = cam ? `; ${cam.projectionMode} camera at (${[cam.position.x, cam.position.y, cam.position.z].map(round).join(', ')}) looking at (${[cam.target.x, cam.target.y, cam.target.z].map(round).join(', ')})` : '';
    return {
      text: `Viewport screenshot, ${size.width}x${size.height} ${match[1]} (viewport ${source.width}x${source.height})${at}.`,
      structured,
      image: { data, mimeType: match[1] as 'image/png' | 'image/jpeg' },
    };
  } };
}

export const screenshotTools = { viewer_screenshot: createScreenshotTool() } satisfies Record<keyof typeof SCREENSHOT_SPECS, ModelFreeTool>;
