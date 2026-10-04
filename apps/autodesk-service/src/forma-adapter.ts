/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeArtifactAdapter } from './config.js';
import { address, immutableUrn, metadata, object, text } from './native-common.js';
import { readArtifact, runNative, scratch } from './native-process.js';
import { apsUrl, boundedResponse, downloadSigned, ServiceError } from './upstream.js';

/** Fetch immutable element revisions once; Rust expands occurrences without deduping instances. */
export function formaAdapter(command: string, fetcher = fetch, maxBytes = 512 * 1024 * 1024): NativeArtifactAdapter {
  return { kind: 'proposal', async convert({ ref, region, accessToken, signal }) {
    const project = address(ref.projectId); const container = address(ref.containerId);
    if (project.kind !== 'site' || !project.id || container.kind !== 'proposals' || container.project !== project.project ||
        container.id !== project.id || project.region !== region || container.region !== region ||
        !ref.revisionId.startsWith(`${ref.fileId}:`) || !ref.fileId.startsWith(`urn:adsk-forma-elements:proposal:${project.project}:`)) {
      throw new ServiceError(400, 'invalid-reference', 'Proposal and selected site do not match.');
    }
    immutableUrn(ref.revisionId, project.project);
    return scratch(async (directory) => {
      const site = await metadata(fetcher, `/forma/site/v1alpha/sites/${encodeURIComponent(project.id!)}`, accessToken, region, signal);
      if (site.projectId !== project.project || site.id !== project.id) throw new ServiceError(502, 'site-mismatch', 'Autodesk returned another site.');
      const elements: Record<string, Record<string, unknown>> = Object.create(null);
      const blobs: Record<string, string> = Object.create(null);
      const pending = [ref.revisionId]; const queued = new Set(pending);
      let bytes = 0;
      let metadataBytes = Buffer.byteLength(JSON.stringify(site));
      while (pending.length) {
        signal.throwIfAborted();
        if (queued.size > 10_000) throw new ServiceError(413, 'element-limit', 'Proposal exceeds the configured element limit.');
        const urn = pending.pop()!;
        const context = urn.split(':')[3];
        const payload = await metadata(fetcher, `/forma/element-service/v1alpha/elements/${encodeURIComponent(urn)}?authcontext=${encodeURIComponent(context)}&recursive=false`, accessToken, region, signal);
        // REST documents a keyed element map; Embedded View responses expose a direct
        // element. Both must carry the exact requested immutable URN.
        const primary = object(payload.element);
        const element = primary.urn === urn ? primary : object(primary[urn]);
        if (element.urn !== urn) throw new ServiceError(502, 'revision-mismatch', 'Autodesk returned another element revision.');
        metadataBytes += Buffer.byteLength(JSON.stringify(element));
        if (metadataBytes > 64 * 1024 * 1024) throw new ServiceError(413, 'metadata-limit', 'Proposal metadata exceeds the import limit.');
        elements[urn] = element;
        const children = element.children ?? [];
        if (!Array.isArray(children) || children.length > 10_000) throw new ServiceError(413, 'element-limit', 'Invalid or oversized element children.');
        for (const child of children) {
          const childUrn = immutableUrn(text(object(child).urn));
          if (!queued.has(childUrn)) { queued.add(childUrn); pending.push(childUrn); }
        }
        const reps = element.representations === undefined ? {} : object(element.representations);
        if (reps.volumeMesh) {
          const mesh = object(reps.volumeMesh);
          if (mesh.type !== 'linked') throw new ServiceError(422, 'unsupported-mesh', 'This Forma mesh representation is not supported.');
          const blob = text(mesh.blobId);
          const blobKey = `${context}:${blob}`;
          if (!(blobKey in blobs)) {
            const controller = new AbortController();
            const blobSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60_000)]);
            const path = `/forma/element-service/v1alpha/blobs/${encodeURIComponent(blob)}?authcontext=${encodeURIComponent(context)}`;
            let response = await fetcher(apsUrl(path), { headers: { Authorization: `Bearer ${accessToken}`, 'X-Ads-Region': region }, redirect: 'manual', signal: blobSignal });
            if (response.status === 302) {
              const location = response.headers.get('location'); await response.body?.cancel();
              response = await downloadSigned(fetcher, location, blobSignal);
            }
            if (!response.ok) throw new ServiceError(502, 'blob-failed', 'The Forma mesh could not be downloaded.');
            const data = new Uint8Array(await boundedResponse(response, maxBytes - bytes, controller).arrayBuffer());
            bytes += data.byteLength;
            const name = `blob-${Object.keys(blobs).length}.glb`;
            await writeFile(join(directory, name), data, { mode: 0o600 }); blobs[blobKey] = name;
          }
        }
      }
      const manifest = join(directory, 'snapshot.json'); const artifact = join(directory, 'model.ifcx');
      const json = JSON.stringify({ revisionId: ref.revisionId, elements, blobs, site });
      if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new ServiceError(413, 'metadata-limit', 'Proposal metadata exceeds the import limit.');
      await writeFile(manifest, json, { mode: 0o600 });
      await runNative(command, [manifest, artifact], directory, undefined, signal);
      return { revisionId: ref.revisionId, format: 'ifcx', bytes: await readArtifact(directory, artifact, maxBytes) };
    });
  } };
}
