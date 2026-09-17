/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { next } from '@vercel/functions';
import { deploymentAssetsDir } from './scripts/lib/deployment-assets-dir.mjs';

const DEPLOYMENT_COOKIE = '__vdpl';

/**
 * Build the response headers that pin a browser to the deployment which
 * served its document. Set-Cookie is deliberately emitted by middleware,
 * before the HTML body reaches the preload scanner (issues #1457 and #4649).
 *
 * The cookie is intentionally readable by the viewer's bounded boot recovery:
 * if Vercel has retired the pinned deployment, that recovery can expire the
 * pin before its one-time reload. A deployment id is routing metadata, not a
 * credential.
 *
 * @param {Request} request
 * @param {string | undefined} deploymentId
 * @param {string | undefined} skewProtectionEnabled
 * @returns {Headers | undefined}
 */
export function deploymentPinHeaders(request, deploymentId, skewProtectionEnabled) {
  if (skewProtectionEnabled !== '1' || !deploymentId || !isDocumentRequest(request)) {
    return undefined;
  }

  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    `${DEPLOYMENT_COOKIE}=${encodeURIComponent(deploymentId)}; Path=/; Secure; SameSite=Lax`,
  );
  // The pin above is browser-wide, and Vercel serves every real navigation
  // from the LATEST deployment, so any navigation in any tab rewrites it and
  // strands the lazy assets of every older tab (#4886). This second pin is
  // scoped to the directory this deployment's build wrote its assets into
  // (see scripts/lib/deployment-assets-dir.mjs): the browser sends the
  // longest-path cookie first and Vercel honours the first `__vdpl`, so this
  // build's asset requests stay on this deployment whatever other tabs load.
  // Bounded to the Skew Protection window so old builds' pins do not pile up.
  const assetsDir = deploymentAssetsDir(deploymentId, skewProtectionEnabled);
  if (assetsDir !== 'assets') {
    headers.append(
      'Set-Cookie',
      `${DEPLOYMENT_COOKIE}=${encodeURIComponent(deploymentId)}; Path=/${assetsDir}/; Max-Age=${ASSET_PIN_MAX_AGE_S}; Secure; SameSite=Lax`,
    );
  }
  return headers;
}

/** The project's Skew Protection maximum age (7 days): a pin older than that routes nowhere. */
const ASSET_PIN_MAX_AGE_S = 7 * 24 * 60 * 60;

/** @param {Request} request */
function isDocumentRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.get('sec-fetch-dest') === 'document') return true;
  return request.headers.get('accept')?.split(',').some((type) => type.trim().startsWith('text/html')) ?? false;
}

/** @param {Request} request */
export default function middleware(request) {
  const headers = deploymentPinHeaders(
    request,
    process.env.VERCEL_DEPLOYMENT_ID,
    process.env.VERCEL_SKEW_PROTECTION_ENABLED,
  );
  return next(headers ? { headers } : undefined);
}

// Avoid running an Edge function for immutable assets and API calls. Other
// dotted paths must reach the request-level document check: /index.html is a
// valid viewer entry point and must receive the same pin as `/` (#4649).
export const config = {
  matcher: ['/((?!api(?:/|$)|assets(?:/|$)).*)'],
  runtime: 'nodejs',
};
