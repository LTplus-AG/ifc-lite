/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's bar and scene layer, loaded when the tool is first opened (#7616).
 *
 * The Section UI (the bar, its menus, saved views, zoom, the in-scene marks) is only needed once
 * the tool is open, so it does not belong in the entry chunk that every session pays for.
 * `preloadSectionTool` fetches the same chunks when the browser is idle, so opening the tool on a
 * warm cache mounts without waiting for the network.
 *
 * These are not `React.lazy`: a lazy component suspends on its FIRST render even when its module
 * is already loaded. Here the settled chunk is kept and rendered directly, so a tool opened after
 * the preload mounts in the same render with no Suspense fallback frame; before that the render
 * suspends on the load (React's thenable protocol, the same one `lazy` uses).
 */

import { type ComponentType } from 'react';

function lazyComponent(load: () => Promise<ComponentType>): { Component: ComponentType; ready: () => Promise<void> } {
  let loaded: ComponentType | null = null;
  let pending: Promise<ComponentType> | null = null;
  const start = (): Promise<ComponentType> => {
    pending ??= load().then(
      (component) => { loaded = component; return component; },
      (error: unknown) => { pending = null; throw error; }, // a later open tries the network again
    );
    return pending;
  };
  const Component: ComponentType = () => {
    const started = start();
    if (!loaded) throw started;
    const Loaded = loaded;
    return <Loaded />;
  };
  return { Component, ready: async () => { await start(); } };
}

const bar = lazyComponent(() => import('@/components/viewer/tools/SectionToolbar').then((m) => m.SectionToolbar));
const scene = lazyComponent(() => import('@/components/viewer/tools/SectionPanel').then((m) => m.SectionOverlay));

export const SectionBar = bar.Component;
export const SectionScene = scene.Component;

/** Resolves once the Section tool's chunks are loaded; a failure rejects, and the next call tries again. */
export function loadSectionTool(): Promise<void> {
  return Promise.all([bar.ready(), scene.ready()]).then(() => undefined);
}

/**
 * Start fetching the chunks without waiting; safe to call repeatedly. A failed preload is only a
 * warning: opening the tool loads the same chunks again and reports a failure there.
 */
export function preloadSectionTool(): void {
  loadSectionTool().catch((error: unknown) => console.warn('Section tool preload failed', error));
}
