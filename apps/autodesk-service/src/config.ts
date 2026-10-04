/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export interface AutodeskServiceConfig {
  /** Public viewer origin. Reverse-proxy /api/autodesk here on that origin. */
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Only explicit loopback development may use plaintext HTTP/cookies. */
  readonly insecureLocalhost?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly maxSessions?: number;
  readonly maxConcurrentImports?: number;
  readonly maxArtifactBytes?: number;
  readonly adapters?: readonly NativeArtifactAdapter[];
}
export interface NativeArtifactAdapter {
  readonly kind: 'exchange' | 'proposal';
  /** Must return a supported native IFC or IFCX artifact from this exact revision. */
  convert(input: {
    readonly ref: { projectId: string; containerId: string; fileId: string; revisionId: string };
    readonly region: 'US' | 'EMEA';
    readonly accessToken: string;
    readonly signal: AbortSignal;
  }): Promise<{ revisionId: string; format: 'ifc' | 'ifcx'; bytes: Uint8Array }>;
}
export function validateConfig(config: AutodeskServiceConfig): URL {
  const origin = new URL(config.origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (config.insecureLocalhost && !loopback) throw new Error('Insecure Autodesk cookies are allowed only on loopback development origins.');
  for (const value of [config.maxSessions, config.maxArtifactBytes, config.maxConcurrentImports]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Autodesk capacity and byte limits must be positive safe integers.');
  }
  if (origin.origin !== config.origin || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(config.insecureLocalhost && loopback && origin.protocol === 'http:'))) {
    throw new Error('AUTODESK_VIEWER_ORIGIN must be an exact HTTPS origin (explicit loopback HTTP is development only).');
  }
  if (!config.clientId.trim() || !config.clientSecret.trim()) throw new Error('Configure AUTODESK_CLIENT_ID and AUTODESK_CLIENT_SECRET server-side.');
  return origin;
}
