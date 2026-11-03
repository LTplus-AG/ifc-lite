/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which geometry kernel the NEXT load uses (#7955 M2): `exact` (default) or
 * `retained` (experimental, shape-only). Not the fast/exact fidelity switch
 * in `geometryFidelity.ts` — that one is about cuts and density.
 *
 * Three sources, first valid one wins:
 * 1. `?kernel=exact|retained` in the address. Remembered for the tab in
 *    `sessionStorage`, so a reload of the same tab keeps it.
 * 2. A tab override: `?kernel=` remembered as above, or "Reload with exact
 *    kernel" / a refusal's Retry, which switch only this tab to exact.
 * 3. The Settings choice, saved per browser in `localStorage`. It applies only
 *    where the page is cross-origin isolated: retained needs SharedArrayBuffer,
 *    and the setting shows Exact elsewhere, so the load must not differ.
 * Nothing set: exact. Imported only by the retained modules, so a default
 * build has no kernel choice at all.
 */

export type GeometryKernel = 'exact' | 'retained';

/** Tab override (`?kernel=` or an exact retry), in `sessionStorage`. */
export const GEOMETRY_KERNEL_SESSION_KEY = 'ifc-lite:geometry-kernel';
/** The Settings choice, in `localStorage`. */
export const GEOMETRY_KERNEL_SETTING_KEY = 'ifc-lite:geometry-kernel-setting';

type KernelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(kind: 'sessionStorage' | 'localStorage'): KernelStorage | null {
  try {
    return typeof globalThis[kind] === 'undefined' ? null : globalThis[kind];
  } catch {
    return null; // storage denied (sandboxed frame): exact, every time
  }
}

function parse(value: string | null | undefined): GeometryKernel | null {
  return value === 'exact' || value === 'retained' ? value : null;
}

function read(storage: KernelStorage | null, key: string): GeometryKernel | null {
  try {
    return parse(storage?.getItem(key));
  } catch {
    return null;
  }
}

function write(storage: KernelStorage | null, key: string, value: GeometryKernel | null): void {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {
    // quota or denied storage: the choice still applies to this call
  }
}

/** Rewrite a `?kernel=` left in the address so it cannot override the choice on a reload. */
function rewriteUrl(kernel: GeometryKernel): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  if (!url.searchParams.has('kernel')) return;
  url.searchParams.set('kernel', kernel);
  history.replaceState(history.state, '', url);
}

/**
 * The kernel for the next load. A valid `?kernel=` wins and is remembered for
 * the tab; any other value is ignored, like every unknown parameter. Then the
 * tab override, then the saved Settings choice, then exact.
 */
export function requestedGeometryKernel(
  search: string = typeof location === 'undefined' ? '' : location.search,
  session: KernelStorage | null = store('sessionStorage'),
  local: KernelStorage | null = store('localStorage'),
  isolated: boolean = crossOriginIsolatedPage(),
): GeometryKernel {
  const fromUrl = parse(new URLSearchParams(search).get('kernel'));
  if (fromUrl) {
    write(session, GEOMETRY_KERNEL_SESSION_KEY, fromUrl);
    return fromUrl;
  }
  return read(session, GEOMETRY_KERNEL_SESSION_KEY) ?? (isolated ? read(local, GEOMETRY_KERNEL_SETTING_KEY) : null) ?? 'exact';
}

/** Retained needs SharedArrayBuffer, so only a cross-origin isolated page can run it. */
export function crossOriginIsolatedPage(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** The kernel saved in Settings for this browser (exact when none is saved). */
export function savedGeometryKernel(local: KernelStorage | null = store('localStorage')): GeometryKernel {
  return read(local, GEOMETRY_KERNEL_SETTING_KEY) ?? 'exact';
}

/**
 * Switch only this tab (a refusal's Retry, "Reload with exact kernel"). The
 * saved Settings choice is left alone; a new tab uses it again.
 */
export function chooseGeometryKernel(kernel: GeometryKernel, session: KernelStorage | null = store('sessionStorage')): void {
  write(session, GEOMETRY_KERNEL_SESSION_KEY, kernel);
  rewriteUrl(kernel);
}

/**
 * The Settings choice: saved for this browser, and it replaces any tab
 * override, so the next load in this tab uses it too.
 */
export function saveGeometryKernel(
  kernel: GeometryKernel,
  session: KernelStorage | null = store('sessionStorage'),
  local: KernelStorage | null = store('localStorage'),
): void {
  write(local, GEOMETRY_KERNEL_SETTING_KEY, kernel === 'exact' ? null : kernel);
  write(session, GEOMETRY_KERNEL_SESSION_KEY, null);
  rewriteUrl(kernel);
}
