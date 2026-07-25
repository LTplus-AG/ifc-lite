/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Playwright render host for the moonshot video pipelines.
 *
 * Serves viewer.html + the workspace's own three.js build + a scene
 * directory over a loopback HTTP server, drives real Chrome (same
 * execution model as scripts/moonshot/gpu-predicates/harness-b25.mjs),
 * and exposes frame rendering as an async function.
 */

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VIDEO_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(VIDEO_DIR, '../../..');

/** Resolve the workspace's installed three.js module build (no CDN). */
export function resolveThree() {
  const req = createRequire(path.join(REPO_ROOT, 'apps/viewer/package.json'));
  // The three package's exports map hides subpaths; resolve the CJS entry
  // (build/three.cjs) and take its ESM sibling.
  const cjs = req.resolve('three');
  const esm = path.join(path.dirname(cjs), 'three.module.js');
  if (!existsSync(esm)) throw new Error(`three ESM build not found at ${esm}`);
  return esm;
}

/**
 * @param {{ sceneDir: string, headless?: boolean }} opts
 * @returns host with { page, renderFrame, loadScene, close, baseUrl }
 */
export async function startRenderHost({ sceneDir, headless = true }) {
  const threePath = resolveThree();
  const threeBuildDir = path.dirname(threePath);
  const viewerHtml = readFileSync(path.join(VIDEO_DIR, 'viewer.html'));

  const debug = process.env.VIDEO_DEBUG === '1';
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (debug) console.log('[render-host] GET', url);
    try {
      if (url === '/' || url === '/viewer.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(viewerHtml);
      } else if (url.startsWith('/vendor/')) {
        // three.module.js imports sibling chunks (three.core.js); serve the
        // whole build directory of the workspace's three install.
        const rel = path.normalize(url.slice('/vendor/'.length));
        if (rel.startsWith('..')) throw new Error('path escape');
        const file = path.join(threeBuildDir, rel);
        if (!existsSync(file)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(readFileSync(file));
      } else if (url.startsWith('/scenes/')) {
        const rel = path.normalize(url.slice('/scenes/'.length));
        if (rel.startsWith('..')) throw new Error('path escape');
        const file = path.join(sceneDir, rel);
        if (!existsSync(file)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(readFileSync(file));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (err) => console.error('[page error]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page console]', msg.text());
  });
  await page.goto(`${baseUrl}/viewer.html`);
  await page.waitForFunction(() => window.__viewerUp === true, undefined, { timeout: 30000 });
  const info = await page.evaluate(() => window.rendererInfo());
  console.log(`[render-host] ${info.webgl2 ? 'WebGL2' : 'WebGL1'} on ${info.vendor}`);

  async function initScene(cfg) {
    return page.evaluate((c) => window.initScene(c), cfg);
  }

  async function loadScene(name, relPath) {
    return page.evaluate(
      ([n, u]) => window.loadScene(n, u),
      [name, `/scenes/${relPath}`],
    );
  }

  async function disposeScene(name) {
    return page.evaluate((n) => window.disposeScene(n), name);
  }

  /** Render one frame and write it as PNG to outPath. */
  async function renderFrameTo(state, outPath) {
    const dataUrl = await page.evaluate((s) => window.renderFrame(s), state);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    writeFileSync(outPath, Buffer.from(b64, 'base64'));
  }

  async function close() {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { page, baseUrl, initScene, loadScene, disposeScene, renderFrameTo, close };
}

/** Smootherstep ease (0..1 -> 0..1), C2 continuous. */
export function smootherstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Ease-out cubic (0..1 -> 0..1). */
export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/** Orbit camera position around a target (Y-up). Angles in radians. */
export function orbitPosition(target, radius, azimuth, elevation) {
  return [
    target[0] + radius * Math.cos(elevation) * Math.sin(azimuth),
    target[1] + radius * Math.sin(elevation),
    target[2] + radius * Math.cos(elevation) * Math.cos(azimuth),
  ];
}

/**
 * Distance so that a bounding sphere of `radius` fits the vertical AND
 * horizontal FOV with `margin` (>1 = looser).
 */
export function framingDistance(radius, fovDeg, aspect = 16 / 9, margin = 1.15) {
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const limiting = Math.min(vfov, hfov);
  return (radius * margin) / Math.sin(limiting / 2);
}
