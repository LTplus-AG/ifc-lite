/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test';
import { readSessionCounters } from './gpu-health.js';

/**
 * React commits per interaction (#6993), after the load has settled.
 *
 * `react.commits` (apps/viewer/src/lib/perf/reactCommits.ts) counts every
 * commit; per load it follows streaming batch timing, so the benchmark files
 * it under `scheduling`. One user interaction on a quiet page is different:
 * the commits it causes are a property of the code, so the count repeats
 * exactly and a diff means a component re-renders more (or less) per click.
 *
 * Each interaction is measured from a quiet page (no commit for `quietMs`) to
 * the next quiet point, through real input, not store calls:
 *   select     click the first IfcBuilding row of the hierarchy
 *   hover      move the pointer onto the centre of the 3D viewport canvas
 *              (`canvas[data-viewport="main"]`, checked to be what is under
 *              the pointer there; `hoverHit` says
 *              whether the GPU pick found an entity there)
 *   panelOpen  open the Lens panel from the sidebar strip. Not Lists: that
 *              docks below the viewport and resizes it, and on FZK the resize
 *              re-lays the WebGL minimap, which committed 5 or 6 times
 *              between identical runs; Lens replaces the sidebar content only
 * A step that cannot run, or never goes quiet, is null with its reason, never 0.
 */

export const INTERACTIONS = ['select', 'hover', 'panelOpen'] as const;
export type Interaction = (typeof INTERACTIONS)[number];

export interface InteractionCommits {
  commits: Record<Interaction, number | null>;
  /** Whether the hover landed on an entity; null when hover did not run. */
  hoverHit: boolean | null;
  errors: Partial<Record<Interaction, string>>;
}

/** What the measurement needs from a page; a stub in tests. */
export interface CommitProbe {
  readCommits(): Promise<number | null>;
  pause(ms: number): Promise<void>;
  now(): number;
}

export interface QuietOptions {
  quietMs: number;
  maxMs: number;
  pollMs: number;
}

/** Wait until `react.commits` has not moved for `quietMs`; null when it never does within `maxMs`. */
export async function waitForQuietCommits(probe: CommitProbe, { quietMs, maxMs, pollMs }: QuietOptions): Promise<number | null> {
  const start = probe.now();
  let last = await probe.readCommits();
  if (last === null) return null;
  let since = probe.now();
  while (probe.now() - since < quietMs) {
    if (probe.now() - start >= maxMs) return null;
    await probe.pause(pollMs);
    const current = await probe.readCommits();
    if (current === null) return null;
    if (current !== last) {
      last = current;
      since = probe.now();
    }
  }
  return last;
}

/** Commits caused by `action`, quiet point to quiet point. Throws with the reason when unmeasurable. */
export async function commitsFor(
  probe: CommitProbe,
  action: () => Promise<void>,
  { before, after }: { before: QuietOptions; after: QuietOptions },
): Promise<number> {
  const start = await waitForQuietCommits(probe, before);
  if (start === null) throw new Error('page never went quiet before the interaction (or exposes no react.commits)');
  await action();
  const end = await waitForQuietCommits(probe, after);
  if (end === null) throw new Error('commits never went quiet after the interaction');
  return end - start;
}

/** The 3D viewport canvas (`Viewport.tsx`), never the minimap or a 2D drawing canvas. */
export const VIEWPORT_CANVAS = 'canvas[data-viewport="main"]';

/** Where the pointer rests between steps: the page's top-left corner, off the viewport. */
const POINTER_REST = { x: 1, y: 1 };

// 4 s: longer than the 3 s auto-dismiss of the viewer's success toasts (the
// "GPU recovered" notification among them), whose dismissal commit otherwise
// lands inside a later step's window.
const BEFORE: QuietOptions = { quietMs: 4_000, maxMs: 30_000, pollMs: 100 };
const AFTER: QuietOptions = { quietMs: 1_000, maxMs: 30_000, pollMs: 100 };

/** Run every interaction in order on a loaded viewer and count the commits each one causes. */
export async function measureInteractionCommits(page: Page, now: () => number = Date.now): Promise<InteractionCommits> {
  const probe: CommitProbe = {
    readCommits: async () => (await readSessionCounters(page))?.['react.commits'] ?? null,
    pause: (ms) => page.waitForTimeout(ms),
    now,
  };
  const result: InteractionCommits = { commits: { select: null, hover: null, panelOpen: null }, hoverHit: null, errors: {} };
  const steps: Record<Interaction, () => Promise<void>> = {
    select: () => page.locator('[data-hierarchy-node-type="IfcBuilding"]').first().click({ timeout: 10_000 }),
    hover: async () => {
      // The viewport by its own marker: FZK's page also holds a WebGL minimap
      // canvas, which can come first in document order (#6993 review).
      const box = await page.locator(VIEWPORT_CANVAS).boundingBox();
      if (!box) throw new Error(`no viewport canvas (${VIEWPORT_CANVAS})`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const target = await page.evaluate(([px, py, selector]) => {
        const hit = document.elementFromPoint(px, py);
        return hit === document.querySelector(selector) ? null : `${hit?.tagName ?? 'nothing'}${hit?.className ? `.${String(hit.className).split(' ')[0]}` : ''}`;
      }, [x, y, VIEWPORT_CANVAS] as const);
      if (target !== null) throw new Error(`the viewport centre is covered by ${target}, so the pointer would not hover the viewport`);
      await page.mouse.move(x, y);
    },
    panelOpen: () => page.getByRole('button', { name: 'Lens', exact: true }).first().click({ timeout: 10_000 }),
  };
  for (const name of INTERACTIONS) {
    try {
      result.commits[name] = await commitsFor(probe, steps[name], { before: BEFORE, after: AFTER });
      if (name === 'hover') {
        result.hoverHit = await page.evaluate(() => {
          const store = (globalThis as { __ifc_lite_viewer_store__?: { getState(): { hoverState?: { entityId: number | null } } } }).__ifc_lite_viewer_store__;
          return (store?.getState().hoverState?.entityId ?? null) !== null;
        });
        // Leave the viewport before the next step, outside any measured window:
        // opening a panel resizes the viewport under a resting pointer, and the
        // re-pick that causes would be charged to panelOpen (6 vs 7 commits
        // between runs, depending on what lands under the pointer).
        await page.mouse.move(POINTER_REST.x, POINTER_REST.y);
      }
    } catch (error) {
      result.errors[name] = error instanceof Error ? error.message.split('\n')[0] : String(error);
    }
  }
  return result;
}
