/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListOptions, Page, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';
import { checkedPath, enc, optionalText, record, rows, text, type Api } from './api.js';
import type { Address } from './refs.js';

export async function proposals(api: Api, site: Address, containerId: string, options?: ListOptions, canImport = false): Promise<Page<SourceFile>> {
  const base = '/forma/proposal/v1alpha/proposals';
  const path = options?.cursor ? checkedPath(options.cursor, base)
    : `${base}?authcontext=${enc(site.project)}&limit=${Math.max(1, Math.min(100, options?.limit ?? 100))}`;
  // A continuation stays in the selected site authorization context.
  if (new URL(path, 'https://developer.api.autodesk.com').searchParams.get('authcontext') !== site.project) {
    throw new Error('Forma proposal cursor belongs to another site.');
  }
  const value = record(await api.get(path, site.region, options?.signal));
  const pagination = value.pagination ? record(value.pagination) : {};
  const next = optionalText(pagination.nextUrl);
  return {
    items: rows(value.results).map((row) => {
      const props = record(row.properties);
      const metadata = row.metadata ? record(row.metadata) : {};
      const urn = text(row.urn, 'proposal revision');
      if (!urn.startsWith(`urn:adsk-forma-elements:proposal:${site.project}:`) || urn.split(':').length !== 6) throw new Error('Proposal and site context do not match.');
      const name = text(props.name ?? urn, 'proposal name');
      return {
        id: urn.slice(0, urn.lastIndexOf(':')), currentRevisionId: urn, containerId,
        name, kind: 'proposal', artifactName: `${name}.ifcx`, modifiedAt: optionalText(metadata.createdAt),
        unavailableReason: canImport ? undefined : 'Native Forma proposal import is not configured on this deployment.',
        meta: { siteId: site.id, region: site.region },
      };
    }), cursor: next ? checkedPath(next, base) : undefined,
  };
}

export async function proposalVersions(api: Api, site: Address, fileId: string, options?: ListOptions): Promise<Page<SourceRevision>> {
  const match = /^urn:adsk-forma-elements:proposal:([^:]+):([^:]+)$/.exec(fileId);
  if (!match || match[1] !== site.project) throw new Error('Proposal and site context do not match.');
  const base = `/forma/proposal/v1alpha/proposals/${enc(match[2])}/revisions`;
  const path = options?.cursor ? checkedPath(options.cursor, base)
    : `${base}?authcontext=${enc(site.project)}&limit=${Math.max(1, Math.min(100, options?.limit ?? 100))}`;
  if (new URL(path, 'https://developer.api.autodesk.com').searchParams.get('authcontext') !== site.project) throw new Error('Proposal cursor belongs to another site.');
  const value = record(await api.get(path, site.region, options?.signal));
  const pagination = value.pagination ? record(value.pagination) : {};
  const next = optionalText(pagination.nextUrl);
  return { items: rows(value.results).map((row) => {
    const metadata = record(row.metadata);
    const id = text(row.urn);
    if (!id.startsWith(`${fileId}:`)) throw new Error('Forma returned a revision from another proposal.');
    return { id, label: id.slice(id.lastIndexOf(':') + 1), createdAt: text(metadata.createdAt), createdBy: optionalText(metadata.createdBy) };
  }), cursor: next ? checkedPath(next, base) : undefined };
}
