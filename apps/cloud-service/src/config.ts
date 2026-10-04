/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export type Vendor = 'dropbox' | 'msgraph';
export interface AppCredentials { clientId: string; clientSecret: string; tenant?: string }
export interface CloudConfig {
  origin: string;
  apps: Partial<Record<Vendor, AppCredentials>>;
  insecureLocalhost?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  maxSessions?: number;
  maxOperations?: number;
  downloadDirectory?: string;
}
export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function validateConfig(config: CloudConfig): void {
  const url = new URL(config.origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== config.origin || (url.protocol !== 'https:' && !(local && config.insecureLocalhost && url.protocol === 'http:')) || (config.insecureLocalhost && !local)) throw new Error('CLOUD_VIEWER_ORIGIN must be an exact HTTPS origin.');
  for (const app of Object.values(config.apps)) {
    if (!app) continue;
    if (!app.clientId.trim() || !app.clientSecret.trim()) throw new Error('Cloud app configuration requires both client ID and secret.');
    if (app.tenant !== undefined && !validTenant(app.tenant)) throw new Error('Invalid Microsoft tenant.');
  }
  for (const limit of [config.maxSessions, config.maxOperations]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Cloud limits must be positive integers.');
}
export function validTenant(tenant: string): boolean {
  if (['common', 'organizations', 'consumers'].includes(tenant)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) return true;
  if (tenant.length > 253 || !tenant.includes('.')) return false;
  const labels = tenant.split('.');
  return labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) &&
    /^[a-z]{2,63}$/i.test(labels[labels.length - 1] ?? '');
}
export function endpoints(vendor: Vendor, app: AppCredentials): { authorize: string; token: string; scope: string } {
  return vendor === 'dropbox'
    ? { authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', scope: 'account_info.read files.metadata.read files.content.read' }
    : { authorize: `https://login.microsoftonline.com/${app.tenant ?? 'common'}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${app.tenant ?? 'common'}/oauth2/v2.0/token`, scope: 'User.Read Files.Read offline_access' };
}
