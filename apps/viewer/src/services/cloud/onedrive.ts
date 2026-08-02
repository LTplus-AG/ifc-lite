/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side OneDrive / SharePoint provider (Microsoft Graph). Auth/connection
 * lifecycle lives in `OAuthCloudProvider`; this class implements Graph's
 * folder-listing and download shape. Files stream directly from Microsoft to the
 * browser.
 *
 * Navigation spans two sources behind one tree. `CloudFileEntry.path` carries a
 * small structured token so any item resolves to the right Graph endpoint:
 *
 *   ''                       → virtual root: "My OneDrive" + followed SharePoint sites
 *   'me-root'                → /me/drive/root/children
 *   'site:<siteId>'          → /sites/<siteId>/drive/root/children  (default library)
 *   'dl:<driveId>:<itemId>'  → /drives/<driveId>/items/<itemId>/children  (and /content)
 *
 * Real files always arrive as `dl:` entries (they carry their drive id), so a
 * single download path serves both OneDrive and SharePoint. Browsing additional
 * (non-default) document libraries per site is a possible follow-up.
 */

import {
  type CloudDownloadProgress,
  type CloudFileEntry,
  isSupportedCloudFile,
} from './types.js';
// Microsoft Graph error codes/messages that mean "SharePoint doesn't apply to
// this account" (personal/consumer Microsoft accounts have no sites at all)
// rather than a genuine failure of the request. Consumer accounts typically
// come back 400 (SPO doesn't exist for the tenant) or 404 (no such resource
// for a personal MSA); anything else (5xx, network throw, unexpected 401
// already handled separately) is treated as a real failure and surfaced as
// one, per issue guidance to never silently swallow errors.
const CONSUMER_ACCOUNT_STATUS = new Set([400, 404]);
import { OAuthCloudProvider, readBodyWithProgress, readErrorBody } from './oauth-provider-base.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = '$select=id,name,size,folder,file,lastModifiedDateTime,parentReference';

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string };
}

interface GraphChildren {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

interface GraphSite {
  id: string;
  displayName?: string;
  name?: string;
}

export class OneDriveProvider extends OAuthCloudProvider {
  readonly id = 'onedrive';
  readonly label = 'OneDrive / SharePoint';

  async listFolder(path: string): Promise<CloudFileEntry[]> {
    if (path === '') return this.listRoot();
    if (path === 'me-root') return this.listChildren(`${GRAPH}/me/drive/root/children`);
    if (path.startsWith('site:')) {
      return this.listChildren(`${GRAPH}/sites/${encodeURIComponent(path.slice(5))}/drive/root/children`);
    }
    if (path.startsWith('dl:')) {
      const { driveId, itemId } = parseDriveRef(path);
      return this.listChildren(
        `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`,
      );
    }
    throw new Error(`OneDrive: unrecognized path "${path}"`);
  }

  /** Virtual root: the user's OneDrive plus any SharePoint sites they follow. */
  private async listRoot(): Promise<CloudFileEntry[]> {
    const entries: CloudFileEntry[] = [
      { id: 'me-root', name: 'My OneDrive', path: 'me-root', size: 0, isFolder: true, modifiedMs: null },
    ];
    const sitesResult = await this.fetchFollowedSites();
    if (sitesResult.reason === 'consumer-account') {
      entries.push({
        id: 'sites-unavailable',
        name: 'SharePoint sites need a work or school account',
        path: '',
        size: 0,
        isFolder: false,
        modifiedMs: null,
        disabled: true,
      });
    } else if (sitesResult.reason === 'error') {
      entries.push({
        id: 'sites-unavailable',
        name: "Couldn't check SharePoint sites — try again later",
        path: '',
        size: 0,
        isFolder: false,
        modifiedMs: null,
        disabled: true,
      });
    }
    for (const site of sitesResult.sites) {
      entries.push({
        id: `site:${site.id}`,
        name: site.displayName || site.name || 'SharePoint site',
        path: `site:${site.id}`,
        size: 0,
        isFolder: true,
        modifiedMs: null,
      });
    }
    return entries;
  }

  /**
   * Followed SharePoint sites. Distinguishes a benign "this account has no
   * sites" outcome (personal/consumer Microsoft accounts — SharePoint is a
   * work/school-tenant feature and never has sites to list) from a genuine
   * request failure, so the UI can say which one happened instead of either
   * throwing or silently showing an empty, unexplained list.
   */
  private async fetchFollowedSites(): Promise<{
    sites: GraphSite[];
    reason: 'consumer-account' | 'error' | null;
  }> {
    const accessToken = await this.getAccessToken();
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/me/followedSites?$select=id,displayName,name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      console.error('[onedrive] followedSites request failed:', err);
      return { sites: [], reason: 'error' };
    }
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      if (CONSUMER_ACCOUNT_STATUS.has(res.status)) {
        // Expected for a personal Microsoft account: SharePoint sites simply
        // don't exist for it. Not an error — just log at debug level.
        console.debug(`[onedrive] no SharePoint sites for this account (${res.status})`);
        return { sites: [], reason: 'consumer-account' };
      }
      // 403 (Sites.Read.All not consented on a work/school account), 5xx, or
      // anything unexpected: a real failure, not "no sites". Say so.
      const detail = await readErrorBody(res, this.id);
      console.error(`[onedrive] could not list followed SharePoint sites (${res.status}): ${detail}`);
      return { sites: [], reason: 'error' };
    }
    const data = (await res.json()) as { value?: GraphSite[] };
    return { sites: data.value ?? [], reason: null };
  }

  /** Page through a Graph children endpoint and map to sorted cloud entries. */
  private async listChildren(firstUrl: string): Promise<CloudFileEntry[]> {
    const accessToken = await this.getAccessToken();
    const items: GraphItem[] = [];
    let next: string | undefined = `${firstUrl}?${SELECT}&$top=200`;

    while (next) {
      const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw this.notConnected();
      if (!res.ok) {
        const detail = await readErrorBody(res, this.id);
        throw new Error(`OneDrive list failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as GraphChildren;
      items.push(...(data.value ?? []));
      // nextLink is an absolute URL that already carries the query.
      next = data['@odata.nextLink'];
    }

    return items
      .filter((it) => Boolean(it.folder) || isSupportedCloudFile(it.name))
      .map((it) => this.toEntry(it))
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }

  private toEntry(item: GraphItem): CloudFileEntry {
    const driveId = item.parentReference?.driveId ?? '';
    return {
      id: item.id,
      name: item.name,
      // Drive-qualified ref so folders navigate and files download uniformly.
      path: `dl:${driveId}:${item.id}`,
      size: item.size ?? 0,
      isFolder: Boolean(item.folder),
      modifiedMs: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : null,
    };
  }

  async download(entry: CloudFileEntry, onProgress?: CloudDownloadProgress): Promise<File> {
    const accessToken = await this.getAccessToken();
    const { driveId, itemId } = parseDriveRef(entry.path);
    // Graph 302-redirects /content to a short-lived pre-authenticated download
    // URL; fetch follows it (and browsers drop the Authorization header on the
    // cross-origin hop, which is fine — the redirect target is pre-signed).
    const res = await fetch(
      `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 401) throw this.notConnected();
    if (!res.ok) {
      const detail = await readErrorBody(res, this.id);
      throw new Error(`OneDrive download failed (${res.status}): ${detail}`);
    }

    const total = entry.size || Number(res.headers.get('content-length')) || null;
    const blob = await readBodyWithProgress(res, total, onProgress);
    return new File([blob], entry.name, { type: 'application/x-step' });
  }
}

/** Parse a `dl:<driveId>:<itemId>` token. The item id may itself contain colons. */
function parseDriveRef(path: string): { driveId: string; itemId: string } {
  const body = path.slice('dl:'.length);
  const sep = body.indexOf(':');
  if (sep === -1) throw new Error(`OneDrive: malformed drive ref "${path}"`);
  return { driveId: body.slice(0, sep), itemId: body.slice(sep + 1) };
}

/** Shared singleton used by the importer UI. */
export const onedriveProvider = new OneDriveProvider();
