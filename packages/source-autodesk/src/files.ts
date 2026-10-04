/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DownloadOptions, FileFilter, ListOptions, Page, SourceContainer, SourceFile, SourceFileRef, SourceRevision } from '@ifc-lite/plugin-api';
import { matchesGlob } from '@ifc-lite/plugin-api';
import { attributes, AutodeskError, enc, nextLink, optionalText, record, relation, rows, text, type Api } from './api.js';
import { address, parseAddress, type Address } from './refs.js';

function contentsPath(project: string, folder: string): string {
  return `/data/v1/projects/${enc(project)}/folders/${enc(folder)}/contents`;
}
function pagePath(base: string, options?: ListOptions): string {
  if (options?.cursor) {
    const path = nextLink({ links: { next: options.cursor } }, new URL(base, 'https://developer.api.autodesk.com').pathname);
    if (!path) throw new AutodeskError('invalid-cursor', 'Invalid Autodesk page cursor.');
    return path;
  }
  return `${base}?page[limit]=${Math.max(1, Math.min(200, options?.limit ?? 200))}`;
}
export async function folders(api: Api, project: Address, parent?: Address, options?: ListOptions): Promise<Page<SourceContainer>> {
  if (parent && (parent.project !== project.project || parent.region !== project.region || parent.hub !== project.hub)) throw new AutodeskError('invalid-reference', 'Folder and project do not match.');
  if (!parent) return { items: [
    ...(project.id ? [{ id: address({ ...project, kind: 'folder', view: 'files' }), name: 'Linked Autodesk folder', hasChildren: true }] : []),
    { id: address({ ...project, kind: 'files', view: 'files' }), name: 'Forma Data Management files', hasChildren: true },
    { id: address({ ...project, kind: 'exchanges', view: 'exchanges' }), name: 'Data Exchanges', hasChildren: true },
  ] };
  const base = parent.kind === 'files' || parent.kind === 'exchanges'
    ? `/project/v1/hubs/${enc(text(project.hub, 'hub'))}/projects/${enc(project.project)}/topFolders`
    : contentsPath(project.project, text(parent.id, 'folder'));
  const value = record(await api.get(pagePath(base, options), project.region, options?.signal));
  return {
    items: rows(value.data).filter((row) => row.type === 'folders').map((row) => ({
      id: address({ ...project, kind: 'folder', id: text(row.id), view: parent.view }),
      name: text(attributes(row).name ?? attributes(row).displayName, 'folder name'),
      parentId: address(parent),
    })), cursor: nextLink(value, base),
  };
}
const FORMAT = /\.(ifc|ifcx|ifc5|glb)$/i;
export function fileFromVersion(item: Record<string, unknown>, version: Record<string, unknown> | undefined, containerId: string, imports: boolean): SourceFile {
  const itemAttrs = attributes(item);
  const attrs = version ? attributes(version) : itemAttrs;
  const extension = attrs.extension ? record(attrs.extension) : itemAttrs.extension ? record(itemAttrs.extension) : {};
  const kind = optionalText(extension.type)?.includes('autodesk.bim360:FDX') ||
    optionalText(extension.type)?.includes('autodesk.bim360:DataExchange') ? 'exchange' : 'file';
  const name = text(attrs.displayName ?? attrs.name ?? itemAttrs.displayName ?? itemAttrs.name, 'resource name');
  const revision = version ? text(version.id, 'revision') : relation(item, 'tip');
  if (!revision) throw new AutodeskError('invalid-response', 'Autodesk did not identify the resource’s current revision.');
  return {
    id: text(item.id), name, containerId, currentRevisionId: revision, kind,
    artifactName: kind === 'exchange' ? `${name.replace(/\.\w+$/, '')}.ifc` : undefined,
    unavailableReason: itemAttrs.hidden === true ? 'This item has been deleted.'
      : kind === 'exchange' ? imports ? undefined : 'Native Data Exchange import is not configured on this deployment.'
      : FORMAT.test(name) ? undefined : 'Use an IFC/IFCX/GLB file or a Data Exchange for this authoring format.',
    sizeBytes: typeof attrs.storageSize === 'number' && attrs.storageSize >= 0 ? attrs.storageSize : undefined,
    modifiedAt: optionalText(attrs.lastModifiedTime), modifiedBy: optionalText(attrs.lastModifiedUserName),
    meta: { revisionLabel: attrs.versionNumber, extensionType: extension.type },
  };
}
export async function listFiles(api: Api, project: Address, containerId: string, filter?: FileFilter, options?: ListOptions, imports = false): Promise<Page<SourceFile>> {
  const folder = parseAddress(containerId);
  if (folder.kind !== 'folder') return { items: [] };
  if (folder.project !== project.project || folder.region !== project.region || folder.hub !== project.hub) throw new AutodeskError('invalid-reference', 'Folder and project do not match.');
  const base = contentsPath(project.project, text(folder.id));
  const value = record(await api.get(pagePath(base, options), project.region, options?.signal));
  const included = value.included === undefined ? [] : rows(value.included);
  const files = rows(value.data).filter((row) => row.type === 'items').map((item) => {
    const tip = relation(item, 'tip');
    return fileFromVersion(item, included.find((row) => row.type === 'versions' && row.id === tip), containerId, imports);
  });
  return { items: files.filter((file) => (folder.view !== 'exchanges' || file.kind === 'exchange') &&
      (!filter?.namePatterns?.length || filter.namePatterns.some((p) => matchesGlob(file.name, p)))), cursor: nextLink(value, base) };
}
export async function getFile(api: Api, project: Address, ref: SourceFileRef, imports = false, signal?: AbortSignal): Promise<SourceFile> {
  if (ref.revisionId) return fileFromVersion({ id: ref.fileId }, await getVersion(api, project, ref.fileId, ref.revisionId, signal), ref.containerId, imports);
  const value = record(await api.get(`/data/v1/projects/${enc(project.project)}/items/${enc(ref.fileId)}?include=tip`, project.region, signal));
  const item = record(value.data);
  const tip = relation(item, 'tip');
  const included = value.included === undefined ? [] : rows(value.included);
  return fileFromVersion(item, included.find((row) => row.type === 'versions' && row.id === tip), ref.containerId, imports);
}
export async function versions(api: Api, project: Address, ref: SourceFileRef, options?: ListOptions): Promise<Page<SourceRevision>> {
  const base = `/data/v1/projects/${enc(project.project)}/items/${enc(ref.fileId)}/versions`;
  const value = record(await api.get(pagePath(base, options), project.region, options?.signal));
  return { items: rows(value.data).map((row) => {
    const attrs = attributes(row);
    return { id: text(row.id), label: String(attrs.versionNumber ?? row.id),
      createdAt: text(attrs.createTime ?? attrs.lastModifiedTime, 'revision date'),
      createdBy: optionalText(attrs.createUserName ?? attrs.lastModifiedUserName) };
  }), cursor: nextLink(value, base) };
}
export async function downloadFile(api: Api, project: Address, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
  const revision = ref.revisionId ?? (await getFile(api, project, ref, false, options?.signal)).currentRevisionId;
  const version = await getVersion(api, project, ref.fileId, revision, options?.signal);
  const storage = relation(version, 'storage');
  if (!storage) throw new AutodeskError('unsupported', 'This revision has no downloadable model file.');
  options?.onPhase?.('downloading');
  return api.storage(storage, project.region, options);
}

async function getVersion(api: Api, project: Address, fileId: string, revision: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const value = record(await api.get(`/data/v1/projects/${enc(project.project)}/versions/${enc(revision)}`, project.region, signal));
  const version = record(value.data);
  if (version.id !== revision || relation(version, 'item') !== fileId) {
    throw new AutodeskError('revision-mismatch', 'Autodesk returned a revision belonging to a different resource.');
  }
  return version;
}
