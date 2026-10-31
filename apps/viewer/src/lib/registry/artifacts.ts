/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryTransport } from './transport';
import { RegistryError, releaseName, repositoryName, responseBytes } from './protocol';

export const IFC_ARTIFACT_TYPE = 'application/vnd.ifc-lite.ifc.v1';
export const OCI_MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const MAX_IFC_BYTES = 512 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
/** Bad artifact metadata may be skipped without hiding registry or session failures. */
class UnreadableReleaseError extends RegistryError {}
interface Descriptor { mediaType: string; digest: string; size: number; annotations?: Record<string, string> }
interface Manifest { schemaVersion: 2; mediaType: string; artifactType?: string; config: Descriptor; layers: Descriptor[]; annotations?: Record<string, string> }
export interface RegistryRelease {
  tag: string; title: string; digest: string;
  publisher?: string; pushedAt?: number;
  declaredAuthors?: string; createdAt?: string;
}
export interface ReceivedIfc {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  digest: string;
  reference: string;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function descriptor(value: unknown): Descriptor {
  if (!value || typeof value !== 'object' || !('mediaType' in value) || typeof value.mediaType !== 'string' ||
    !('digest' in value) || typeof value.digest !== 'string' || !SHA256.test(value.digest) ||
    !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new UnreadableReleaseError('The release contains an invalid file descriptor.');
  }
  const annotations: Record<string, string> = {};
  if ('annotations' in value && value.annotations && typeof value.annotations === 'object') {
    for (const [key, item] of Object.entries(value.annotations)) if (typeof item === 'string') annotations[key] = item;
  }
  return { mediaType: value.mediaType, digest: value.digest, size: value.size, annotations };
}

function manifest(bytes: Uint8Array): Manifest {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UnreadableReleaseError('The release contains invalid manifest JSON.');
  }
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 2 ||
    !('mediaType' in value) || value.mediaType !== OCI_MANIFEST_TYPE || !('config' in value) ||
    !('layers' in value) || !Array.isArray(value.layers)) throw new UnreadableReleaseError('This is not a supported OCI artifact manifest.');
  const annotations: Record<string, string> = {};
  if ('annotations' in value && value.annotations && typeof value.annotations === 'object') {
    for (const [key, item] of Object.entries(value.annotations)) if (typeof item === 'string') annotations[key] = item;
  }
  return { schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: descriptor(value.config), layers: value.layers.map(descriptor), annotations };
}

/** Plain IFC source inside an OCI artifact. Also reads a derived release's optional source/model.ifc. */
export class RegistryArtifacts {
  constructor(readonly transport: RegistryTransport) {}

  async tags(repository: string, signal?: AbortSignal): Promise<string[]> {
    const response = await this.transport.request(this.transport.path(repository, 'tags/list'), { signal });
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('tags' in value) || !Array.isArray(value.tags)) {
      throw new RegistryError('The registry returned an invalid release list.');
    }
    return value.tags.filter((tag): tag is string => typeof tag === 'string');
  }

  private async readManifest(repository: string, reference: string, signal?: AbortSignal) {
    if (!SHA256.test(reference)) releaseName(reference);
    const response = await this.transport.request(this.transport.path(repository, `manifests/${encodeURIComponent(reference)}`), {
      signal, headers: { Accept: OCI_MANIFEST_TYPE },
    });
    const raw = await responseBytes(response, 1024 * 1024);
    const digest = await sha256(raw);
    const advertised = response.headers.get('docker-content-digest');
    if ((advertised && advertised !== digest) || (SHA256.test(reference) && reference !== digest)) {
      throw new UnreadableReleaseError('The release fingerprint does not match its manifest.');
    }
    return { data: manifest(raw), digest, response };
  }

  async catalog(signal?: AbortSignal, next = '/v2/_catalog?n=100'): Promise<{ repositories: string[]; next?: string }> {
    if (this.transport.url(next).pathname !== '/v2/_catalog') throw new RegistryError('The model list returned an invalid page address.');
    const response = await this.transport.request(next, { signal });
    const value: unknown = JSON.parse(new TextDecoder().decode(await responseBytes(response, 1024 * 1024)));
    if (!value || typeof value !== 'object' || !('repositories' in value) || !Array.isArray(value.repositories)) throw new RegistryError('The model list could not be read.');
    const repositories = value.repositories.filter((name): name is string => typeof name === 'string').map(repositoryName);
    const link = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
    return { repositories, next: link?.[1] };
  }

  async modelCatalog(signal?: AbortSignal, next?: string): Promise<{ repositories: string[]; titles: Record<string, string>; next?: string }> {
    const page = await this.catalog(signal, next);
    const titles: Record<string, string> = {};
    for (const repository of page.repositories) titles[repository] = repository.split('/').pop() || repository;
    return { ...page, titles };
  }

  async describe(repository: string, tag: string, signal?: AbortSignal): Promise<RegistryRelease> {
    const { data, digest, response } = await this.readManifest(repository, tag, signal);
    const filename = data.layers.find(layer => layer.mediaType === 'application/x-step')?.annotations?.['org.opencontainers.image.title']?.split(/[\\/]/).pop();
    const headers = this.transport.session?.publicationHeaders;
    const pushedAt = Number(headers ? response.headers.get(headers.pushedAt) : null);
    return { tag, digest, title: data.annotations?.['org.opencontainers.image.title'] || filename?.replace(/\.ifc$/i, '') || repository.split('/').pop() || repository,
      publisher: headers ? response.headers.get(headers.publisher) || undefined : undefined,
      pushedAt: Number.isSafeInteger(pushedAt) && pushedAt > 0 ? pushedAt : undefined,
      declaredAuthors: data.annotations?.['org.opencontainers.image.authors'], createdAt: data.annotations?.['org.opencontainers.image.created'] };
  }

  /** List readable versions; retain auth, cancellation, and service failures as errors. */
  async releases(repository: string, signal?: AbortSignal): Promise<RegistryRelease[]> {
    const tags = await this.tags(repository, signal);
    if (tags.length > 1000) throw new RegistryError('This model has too many versions for the local demo. Paste a specific release address.');
    const releases: RegistryRelease[] = [];
    // Small batches avoid flooding the registry while reading release metadata.
    for (let start = 0; start < tags.length; start += 8) {
      const batch = await Promise.allSettled(tags.slice(start, start + 8).map(tag => this.describe(repository, tag, signal)));
      signal?.throwIfAborted();
      for (const result of batch) {
        if (result.status === 'fulfilled') { releases.push(result.value); continue; }
        const failure: unknown = result.reason;
        if (failure instanceof UnreadableReleaseError || (failure instanceof RegistryError && [404, 406, 415].includes(failure.status))) continue;
        throw failure;
      }
    }
    return releases.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0) || b.tag.localeCompare(a.tag, undefined, { numeric: true }));
  }

  async pull(repository: string, reference: string, signal?: AbortSignal): Promise<ReceivedIfc> {
    const { data, digest } = await this.readManifest(repository, reference, signal);
    const candidates = data.layers.filter(layer =>
      layer.mediaType === 'application/x-step' || /\.ifc$/i.test(layer.annotations?.['org.opencontainers.image.title'] ?? ''));
    if (candidates.length !== 1) throw new RegistryError('Choose a release containing exactly one editable IFC source file.');
    const source = candidates[0];
    if (source.size > MAX_IFC_BYTES) throw new RegistryError('This local registry supports files up to 512 MiB.');
    const blob = await this.transport.request(this.transport.path(repository, `blobs/${source.digest}`), { signal });
    const bytes = await responseBytes(blob, source.size);
    if (bytes.length !== source.size || await sha256(bytes) !== source.digest) throw new RegistryError('The IFC file failed its integrity check.');
    const filename = source.annotations?.['org.opencontainers.image.title']?.split(/[\\/]/).pop() || 'model.ifc';
    return { bytes, filename, digest, reference: `${repository}@${digest}` };
  }

  private async upload(repository: string, bytes: Uint8Array<ArrayBuffer>, mediaType: string, signal?: AbortSignal): Promise<Descriptor> {
    if (bytes.length > MAX_IFC_BYTES) throw new RegistryError('This local registry supports files up to 512 MiB.');
    const file = { mediaType, digest: await sha256(bytes), size: bytes.length };
    const existing = await this.transport.request(this.transport.path(repository, `blobs/${file.digest}`), { method: 'HEAD', signal }, true);
    if (existing.status !== 404) return file;
    const start = await this.transport.request(this.transport.path(repository, 'blobs/uploads/'), { method: 'POST', signal });
    const location = start.headers.get('location');
    if (!location) throw new RegistryError('The registry did not return an upload location.');
    const target = this.transport.url(location);
    if (!target.pathname.startsWith(`/v2/${repository}/blobs/uploads/`)) throw new RegistryError('The registry returned an unexpected upload location.');
    target.searchParams.set('digest', file.digest);
    await this.transport.request(target, { method: 'PUT', signal, headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    return file;
  }

  async publish(repository: string, tag: string, bytes: Uint8Array<ArrayBuffer>, filename: string, signal?: AbortSignal): Promise<string> {
    releaseName(tag);
    if (!this.transport.can('push', repository, tag)) throw new RegistryError('This account can receive releases but cannot publish them.', 403);
    if (!new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith('ISO-10303-21;')) {
      throw new RegistryError('Publish an IFC STEP source model for this demo.');
    }
    const path = this.transport.path(repository, `manifests/${encodeURIComponent(tag)}`);
    if (this.transport.can('pull', repository, tag)) {
      const current = await this.transport.request(path, { method: 'HEAD', signal }, true);
      if (current.status !== 404) throw new RegistryError('That version already exists. Choose a new version name.');
    }
    const config = await this.upload(repository, new TextEncoder().encode('{}'), 'application/vnd.oci.empty.v1+json', signal);
    const layer = await this.upload(repository, bytes, 'application/x-step', signal);
    layer.annotations = { 'org.opencontainers.image.title': filename };
    const value: Manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, artifactType: IFC_ARTIFACT_TYPE, config, layers: [layer], annotations: {
      'org.opencontainers.image.title': filename.replace(/\.ifc$/i, ''),
      'org.opencontainers.image.created': new Date().toISOString(),
      'org.opencontainers.image.authors': this.transport.session?.subject ?? '',
    } };
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const digest = await sha256(raw);
    const response = await this.transport.request(path, { method: 'PUT', signal, headers: { 'Content-Type': OCI_MANIFEST_TYPE }, body: raw });
    const advertised = response.headers.get('docker-content-digest');
    if (advertised && advertised !== digest) throw new RegistryError('The registry returned a different release fingerprint.');
    return digest;
  }
}
