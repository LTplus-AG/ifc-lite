/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_screenshot`: argument checks, the downscale and encode inside the
 * native capture's read (the capture itself is faked), the bridge listing,
 * and a clear refusal when no renderer is mounted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { createMainViewerToolHost } from './main-viewer-host';
import { dispatchMainViewerTool } from './main-viewer-dispatch';
import { mainViewerToolDefinitions } from './main-viewer-tool-definitions';
import { createScreenshotTool, fitWidth, type ScreenshotDeps } from './viewport-screenshot-tool';
import type { ToolHost } from './types';

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13));
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1));
const CAMERA = { position: { x: 10.123, y: 5, z: -2 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, projectionMode: 'perspective' as const };

interface Drawn { size: { width: number; height: number }; draw: unknown[]; encoded: unknown[] }

function fakeDeps(source: { width: number; height: number }, drawn: Drawn[] = []): ScreenshotDeps {
  const viewport = { ...source } as HTMLCanvasElement;
  return {
    capture: async (read) => read(viewport),
    camera: () => CAMERA,
    createCanvas: () => {
      const record: Drawn = { size: { width: 0, height: 0 }, draw: [], encoded: [] };
      drawn.push(record);
      const canvas = {
        set width(v: number) { record.size.width = v; },
        set height(v: number) { record.size.height = v; },
        getContext: () => ({ drawImage: (...args: unknown[]) => { record.draw = args; } }),
        toDataURL: (type: string, quality: number) => {
          record.encoded = [type, quality];
          return `data:${type};base64,${type === 'image/png' ? PNG : JPEG}`;
        },
      };
      return canvas as unknown as HTMLCanvasElement;
    },
  };
}

const host = {} as ToolHost;
const run = (deps: ScreenshotDeps, args: Record<string, unknown> = {}) => createScreenshotTool(async () => deps).run(host, args, {});

describe('viewer_screenshot', () => {
  it('scales to max_width keeping the aspect, never up', () => {
    assert.deepEqual(fitWidth(2000, 1000, 1024), { width: 1024, height: 512 });
    assert.deepEqual(fitWidth(1921, 1, 256), { width: 256, height: 1 });
    assert.deepEqual(fitWidth(800, 600, 1024), { width: 800, height: 600 });
  });

  it('downscales the native frame and encodes JPEG at 0.8 by default', async () => {
    const drawn: Drawn[] = [];
    const deps = fakeDeps({ width: 2048, height: 1536 }, drawn);
    const out = await run(deps);
    assert.deepEqual(drawn[0].size, { width: 1024, height: 768 });
    assert.deepEqual(drawn[0].draw.slice(1), [0, 0, 1024, 768]);
    assert.equal((drawn[0].draw[0] as { width: number }).width, 2048, 'draws the captured viewport canvas');
    assert.deepEqual(drawn[0].encoded, ['image/jpeg', 0.8]);
    assert.deepEqual(out.image, { data: JPEG, mimeType: 'image/jpeg' });
    assert.match(out.text, /1024x768 image\/jpeg \(viewport 2048x1536\); perspective camera at \(10\.12, 5, -2\)/);
    assert.deepEqual(out.structured, {
      width: 1024, height: 768, source_width: 2048, source_height: 1536, mime_type: 'image/jpeg',
      camera: { projection: 'perspective', position: CAMERA.position, target: CAMERA.target },
    });
  });

  it('encodes PNG on request and honours max_width', async () => {
    const drawn: Drawn[] = [];
    const out = await run(fakeDeps({ width: 1000, height: 500 }, drawn), { format: 'png', max_width: 256 });
    assert.deepEqual(drawn[0].size, { width: 256, height: 128 });
    assert.equal(drawn[0].encoded[0], 'image/png');
    assert.deepEqual(out.image, { data: PNG, mimeType: 'image/png' });
  });

  it('refuses arguments outside the schema before capturing', async () => {
    let captured = 0;
    const deps = { ...fakeDeps({ width: 10, height: 10 }), capture: async () => { captured++; return null; } };
    for (const args of [{ max_width: 255 }, { max_width: 1921 }, { max_width: 512.5 }, { format: 'webp' }, { other: 1 }]) {
      await assert.rejects(run(deps, args), { code: 'INVALID_INPUT' }, JSON.stringify(args));
    }
    assert.equal(captured, 0);
  });

  it('refuses null optional arguments like any other wrong value', async () => {
    await assert.rejects(run(fakeDeps({ width: 10, height: 10 }), { format: null }), { code: 'INVALID_INPUT' });
    await assert.rejects(run(fakeDeps({ width: 10, height: 10 }), { max_width: null }), { code: 'INVALID_INPUT' });
  });

  it('fails clearly when the capture produced nothing or too much', async () => {
    await assert.rejects(run({ ...fakeDeps({ width: 10, height: 10 }), capture: async () => null }), { code: 'INTERNAL_ERROR' });
    const huge = { ...fakeDeps({ width: 10, height: 10 }), capture: async () => `data:image/png;base64,${PNG}${'A'.repeat(4 * 1024 * 1024)}` };
    await assert.rejects(run(huge), { code: 'INVALID_INPUT', message: /limit is 3145728/ });
  });

  it('is listed to the bridge as a read-only, model-free tool', () => {
    const definition = mainViewerToolDefinitions().find((tool) => tool.name === 'viewer_screenshot');
    assert.ok(definition);
    assert.equal(definition.readOnly, true);
    assert.equal(definition.inputSchema.properties.model_id, undefined);
  });

  it('reports UNSUPPORTED_OPERATION through the dispatcher when no renderer is mounted', async () => {
    const mainHost = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const result = await dispatchMainViewerTool(mainHost, 'viewer_screenshot', {});
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION');
    assert.match(result.text, /renderer is not ready/);
    assert.equal(result.image, undefined);
  });
});
