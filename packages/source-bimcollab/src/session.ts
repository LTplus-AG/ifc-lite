/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch (error) {
    // Opaque (non-JWT) tokens are valid input; report why no claims were read.
    console.debug('[source-bimcollab] access token is not a decodable JWT', error instanceof Error ? error.name : error);
    return null;
  }
}

/**
 * Space GUID carried by a BIMcollab access token, in the `spaceGuid` claim
 * (verified on playground.bimcollab.com, 2026-10-29). Other `*space*` GUID
 * claims are accepted as a fallback in case a deployment names it
 * differently. Returns '' when none is found.
 */
export function spaceIdFromAccessToken(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) return '';
  const claims = Object.entries(payload).sort(([a], [b]) => Number(b === 'spaceGuid') - Number(a === 'spaceGuid'));
  for (const [claim, value] of claims) {
    if (!/space/i.test(claim)) continue;
    const candidates = Array.isArray(value) ? value : [value];
    const guid = candidates.find((v): v is string => typeof v === 'string' && GUID.test(v));
    if (guid) return guid.toLowerCase();
  }
  return '';
}

/** Whether a saved BCF server URL is a BIMcollab space. */
export function isBimcollabServerUrl(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === 'bimcollab.com' || host.endsWith('.bimcollab.com');
  } catch (error) {
    console.debug('[source-bimcollab] not a URL', error instanceof Error ? error.name : error);
    return false;
  }
}


/** Single BIMcollab DNS label from a saved BCF URL, or '' for invalid input. */
export function spaceLabelFromServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.bimcollab\.com$/i.exec(url.hostname)?.[1]?.toLowerCase() ?? '';
  } catch (error) {
    console.debug('[source-bimcollab] not a URL', error instanceof Error ? error.name : error);
    return '';
  }
}
