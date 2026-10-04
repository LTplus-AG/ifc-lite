/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AutodeskError, record, text, type Region } from './api.js';

export interface Address {
  kind: 'project' | 'folder' | 'files' | 'exchanges' | 'site' | 'proposals';
  region: Region;
  project: string;
  hub?: string;
  id?: string;
  view?: 'files' | 'exchanges';
}
/** Versioned address, not a lossy split on URN colons or slashes. */
export function address(value: Address): string { return `adsk1:${encodeURIComponent(JSON.stringify(value))}`; }
export function parseAddress(raw: string): Address {
  try {
    if (!raw.startsWith('adsk1:') || raw.length > 32_768) throw new Error('address');
    const value = record(JSON.parse(decodeURIComponent(raw.slice(6))));
    if (!['project', 'folder', 'files', 'exchanges', 'site', 'proposals'].includes(text(value.kind)) ||
        !['US', 'EMEA'].includes(text(value.region)) ||
        (value.view !== undefined && value.view !== 'files' && value.view !== 'exchanges')) throw new Error('kind');
    return {
      kind: value.kind as Address['kind'], region: value.region as Region,
      project: text(value.project), hub: value.hub === undefined ? undefined : text(value.hub),
      id: value.id === undefined ? undefined : text(value.id),
      view: value.view === 'files' || value.view === 'exchanges' ? value.view : undefined,
    };
  } catch {
    throw new AutodeskError('invalid-reference', 'This Autodesk bookmark is invalid. Browse to the resource again.', undefined);
  }
}

export interface SiteLink { id: string; region: Region }
export function parseSiteLink(input: string): SiteLink {
  const url = new URL(input);
  const hosts: Record<string, Region> = {
    'app.autodeskforma.com': 'US', 'app.autodeskforma.eu': 'EMEA',
  };
  if (url.protocol !== 'https:' || url.username || url.password || !hosts[url.hostname]) {
    throw new AutodeskError('invalid-link', 'Paste an HTTPS Forma Site Design link from Autodesk.');
  }
  const id = url.searchParams.get('siteId') ?? /^\/sites\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
  if (!id) throw new AutodeskError('invalid-link', 'The Forma link must include its siteId or /sites/<id>.');
  return { id: text(id, 'site identifier'), region: hosts[url.hostname] };
}

/** ACC's documented project URL contains a UUID; resolve it through accessible hubs. */
export function parseDocsProjectLink(input: string): { project: string; folder?: string } {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !['acc.autodesk.com', 'acc.autodesk.eu'].includes(url.hostname)) {
    throw new AutodeskError('invalid-link', 'Paste an HTTPS Autodesk Forma Site Design or Data Management project link.');
  }
  const id = /^\/docs\/files\/projects\/([a-f0-9-]{36})(?:\/|$)/i.exec(url.pathname)?.[1];
  if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new AutodeskError('invalid-link', 'The Autodesk Docs link must identify its project.');
  const folder = url.searchParams.get('folderUrn') ?? undefined;
  if (folder && (!folder.startsWith('urn:adsk.') || folder.length > 32_768)) throw new AutodeskError('invalid-link', 'The Autodesk folder reference is invalid.');
  return { project: id.toLowerCase(), folder };
}
