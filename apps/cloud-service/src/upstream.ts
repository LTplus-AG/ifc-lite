/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CloudError } from './config.js';
import { readJson, stripDownloadUrls } from './bounded.js';
import { spoolDownload, type DownloadFile } from './download-file.js';
import type { CloudSession, CloudSessions } from './sessions.js';
const DROPBOX_READ = new Set(['/users/get_current_account', '/files/list_folder', '/files/list_folder/continue', '/files/get_metadata', '/files/search_v2', '/files/search/continue_v2', '/files/list_revisions', '/files/list_folder/get_latest_cursor']);
export function graphUrl(path: string, params?: Record<string, string | number>): URL {
  const url = path.startsWith('https://') ? new URL(path) : new URL(`https://graph.microsoft.com/v1.0${path}`);
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash) throw new CloudError(400, 'invalid-path', 'Unsupported Microsoft operation.');
  const relative = url.pathname.slice('/v1.0'.length);
  const allowed = relative === '/me/drive' || /^\/me\/drive\/(root|items\/[^/]+)(\/(children|versions|delta))?$/.test(relative) || /^\/me\/drive\/root\/search\(q='[^/]*'\)$/.test(relative);
  if (!url.pathname.startsWith('/v1.0/') || !allowed || /%2f|%5c|%00|%2e/i.test(relative) || relative.includes('\\')) throw new CloudError(400, 'invalid-path', 'Unsupported Microsoft operation.');
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  for (const key of url.searchParams.keys()) if (!['$select', '$top', '$skiptoken', '$deltatoken', 'token'].includes(key)) throw new CloudError(400, 'invalid-params', 'Unsupported Microsoft query parameter.');
  return url;
}
async function checked(sessions: CloudSessions, session: CloudSession, url: string | URL, init: RequestInit): Promise<Response> {
  const token = await sessions.access(session);
  const response = await sessions.fetcher(url, { ...init, redirect: 'manual', headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` } });
  if (response.status === 401) { await response.body?.cancel(); sessions.discard(session); throw new CloudError(401, 'authorization-expired', 'Cloud authorization expired. Sign in again.'); }
  if (!response.ok) { await response.body?.cancel(); throw new CloudError(response.status === 403 ? 403 : 502, 'upstream-failed', response.status === 403 ? 'Access to this cloud resource was denied.' : 'The cloud request failed.'); }
  return response;
}
export async function requestJson(sessions: CloudSessions, session: CloudSession, body: { path: string; args?: unknown; params?: Record<string, string | number> }, signal: AbortSignal): Promise<unknown> {
  if (session.vendor === 'dropbox') {
    if (!DROPBOX_READ.has(body.path)) throw new CloudError(400, 'invalid-path', 'Unsupported Dropbox operation.');
    return readJson(await checked(sessions, session, `https://api.dropboxapi.com/2${body.path}`, { method: 'POST', body: JSON.stringify(body.args ?? null), headers: { 'Content-Type': 'application/json' }, signal }));
  }
  return stripDownloadUrls(await readJson(await checked(sessions, session, graphUrl(body.path, body.params), { signal })));
}
export function approvedDownload(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
    (url.hostname.endsWith('.sharepoint.com') || url.hostname.endsWith('.files.1drv.com') || url.hostname === 'public.dm.files.1drv.com');
}
async function anonymousDownload(sessions: CloudSessions, location: string, signal: AbortSignal): Promise<Response> {
  let url = new URL(location);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!approvedDownload(url)) throw new CloudError(502, 'download-host', 'Microsoft returned an unsupported download destination.');
    const response = await sessions.fetcher(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) break; url = new URL(next, url); continue;
    }
    if (response.ok) return response; await response.body?.cancel(); break;
  }
  throw new CloudError(502, 'download-failed', 'Microsoft file download failed.');
}
export async function downloadBytes(sessions: CloudSessions, session: CloudSession, body: { path: string; revision?: string }, signal: AbortSignal): Promise<DownloadFile> {
  if (session.vendor === 'dropbox') {
    if (!body.path || body.path.length > 8192 || body.path.includes('\0') || /^(https?:|\/\/)/i.test(body.path)) throw new CloudError(400, 'invalid-path', 'A Dropbox file reference is required.');
    const response = await checked(sessions, session, 'https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': JSON.stringify({ path: body.path }) }, signal });
    return spoolDownload(response, signal, sessions.downloads);
  }
  const match = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(body.path);
  if (!match || !body.revision) throw new CloudError(400, 'invalid-path', 'A current Microsoft file reference and revision are required.');
  const metadata = graphUrl(`/me/drive/items/${match[1]}`, { $select: 'id,cTag,eTag' });
  const revision = async () => {
    const raw = await readJson(await checked(sessions, session, metadata, { signal }));
    if (!raw || typeof raw !== 'object') throw new CloudError(502, 'invalid-metadata', 'Microsoft file metadata was invalid.');
    const value = raw as Record<string, unknown>;
    return typeof value.cTag === 'string' ? value.cTag : typeof value.eTag === 'string' ? value.eTag : value.id;
  };
  if (await revision() !== body.revision) throw new CloudError(409, 'revision-changed', 'The Microsoft file changed. Refresh and try again.');
  const token = await sessions.access(session);
  const response = await sessions.fetcher(`https://graph.microsoft.com/v1.0${body.path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal });
  let content: Response;
  if (response.status === 302 || response.status === 303 || response.status === 307) {
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) throw new CloudError(502, 'download-failed', 'Microsoft download location was missing.');
    content = await anonymousDownload(sessions, location, signal);
  } else if (response.ok) content = response;
  else { await response.body?.cancel(); if (response.status === 401) sessions.discard(session); throw new CloudError(response.status === 401 ? 401 : 502, 'download-failed', 'Microsoft file download failed.'); }
  const file = await spoolDownload(content, signal, sessions.downloads);
  try {
    if (await revision() !== body.revision) throw new CloudError(409, 'revision-changed', 'The Microsoft file changed during download. Refresh and try again.');
    return file;
  } catch (error) { await file.stream.cancel(); await file.dispose(); throw error; }
}
