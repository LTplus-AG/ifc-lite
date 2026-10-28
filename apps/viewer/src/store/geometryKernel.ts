/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which geometry kernel the NEXT load uses (#7955 M2): `exact` (default) or
 * `retained` (experimental, shape-only). Not the fast/exact fidelity switch
 * in `geometryFidelity.ts` — that one is about cuts and density.
 *
 * Session-only by design: `?kernel=` and the Settings choice live in
 * `sessionStorage`, so a new tab is always exact again. Unlike `?geomTier=`,
 * nothing is written to localStorage. Imported only by the retained module,
 * so a default build has no kernel choice at all.
 */

export type GeometryKernel = 'exact' | 'retained';

export const GEOMETRY_KERNEL_SESSION_KEY = 'ifc-lite:geometry-kernel';

type KernelStorage = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): KernelStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // storage denied (sandboxed frame): exact, every time
  }
}

function parse(value: string | null | undefined): GeometryKernel | null {
  return value === 'exact' || value === 'retained' ? value : null;
}

/**
 * The kernel for the next load. A valid `?kernel=` wins and is remembered for
 * the session (so the choice survives a reload of the same tab); any other
 * value is ignored, like every unknown parameter.
 */
export function requestedGeometryKernel(
  search: string = typeof location === 'undefined' ? '' : location.search,
  storage: KernelStorage | null = sessionStore(),
): GeometryKernel {
  const fromUrl = parse(new URLSearchParams(search).get('kernel'));
  if (fromUrl) {
    storage?.setItem(GEOMETRY_KERNEL_SESSION_KEY, fromUrl);
    return fromUrl;
  }
  return parse(storage?.getItem(GEOMETRY_KERNEL_SESSION_KEY)) ?? 'exact';
}

/**
 * Choose the kernel for the next load (Settings, or "Reload with exact
 * kernel"). The URL is rewritten too, so a `?kernel=` left in the address bar
 * cannot override the choice on the next load or a page reload.
 */
export function chooseGeometryKernel(kernel: GeometryKernel, storage: KernelStorage | null = sessionStore()): void {
  storage?.setItem(GEOMETRY_KERNEL_SESSION_KEY, kernel);
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const url = new URL(location.href);
  if (!url.searchParams.has('kernel')) return;
  url.searchParams.set('kernel', kernel);
  history.replaceState(history.state, '', url);
}
