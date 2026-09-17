/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-deployment asset directory that makes Vercel Skew Protection hold per
 * tab rather than per browser (#4886). ONE home for the rule, shared by the
 * viewer build (vite.config.ts `build.assetsDir`) and the root middleware
 * (the pin cookie's Path), so the directory a build writes and the path its
 * pin is scoped to can never drift apart.
 *
 * Why: Vercel routes a subresource to the deployment named by the first
 * `__vdpl` cookie the browser sends, but serves every real navigation
 * (`Sec-Fetch-Mode: navigate`) from the LATEST deployment. A single `Path=/`
 * pin is therefore rewritten by any navigation in the browser — another tab, a
 * refresh, an OAuth callback popup — and every older tab still open then
 * fetches its hashed workers / wasm / lazy chunks from a deployment that does
 * not have them (404 text/plain → "worker script failed to load"). Scoping a
 * pin cookie to `/assets/<deploymentId>/` gives each build its own pin: a
 * browser sends the longest-path cookie first (RFC 6265 §5.4) and Vercel
 * honours the first `__vdpl`, so a tab's own asset requests stay pinned to its
 * own deployment no matter what other tabs load.
 *
 * Returns the plain `assets` directory — today's layout — unless Skew
 * Protection is on and the deployment id is well formed, so local, CI and
 * non-Vercel builds are unchanged.
 *
 * @param {string | undefined} deploymentId `VERCEL_DEPLOYMENT_ID`
 * @param {string | undefined} skewProtectionEnabled `VERCEL_SKEW_PROTECTION_ENABLED`
 * @returns {string} directory relative to the build output, no leading or trailing slash
 */
export function deploymentAssetsDir(deploymentId, skewProtectionEnabled) {
  if (skewProtectionEnabled !== '1' || !deploymentId) return 'assets';
  // A deployment id becomes a URL path segment and a cookie Path: accept only
  // Vercel's shape, never anything that could escape the directory.
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) return 'assets';
  return `assets/${deploymentId}`;
}
