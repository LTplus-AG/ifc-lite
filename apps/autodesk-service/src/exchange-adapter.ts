/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NativeArtifactAdapter } from './config.js';
import { address, metadata, object, text } from './native-common.js';
import { readArtifact, runNative, scratch } from './native-process.js';
import { ServiceError } from './upstream.js';

export function exchangeAdapter(command: string, fetcher = fetch, maxBytes = 512 * 1024 * 1024): NativeArtifactAdapter {
  return { kind: 'exchange', async convert({ ref, region, accessToken, signal }) {
    const project = address(ref.projectId); const folder = address(ref.containerId);
    if (project.kind !== 'project' || !project.hub || folder.kind !== 'folder' || folder.project !== project.project ||
        folder.hub !== project.hub || folder.region !== region || project.region !== region) {
      throw new ServiceError(400, 'invalid-reference', 'Exchange and selected project do not match.');
    }
    const version = object((await metadata(fetcher, `/data/v1/projects/${encodeURIComponent(project.project)}/versions/${encodeURIComponent(ref.revisionId)}`, accessToken, region, signal)).data);
    const relationships = object(version.relationships); const item = object(object(relationships.item).data);
    const attrs = object(version.attributes); const extension = object(attrs.extension);
    if (version.id !== ref.revisionId || item.id !== ref.fileId ||
        !/autodesk\.bim360:(FDX|DataExchange)/.test(text(extension.type))) {
      throw new ServiceError(400, 'revision-mismatch', 'Selected revision is not this Data Exchange.');
    }
    // SDK whole-exchange export supports current exchange only. Check both Docs
    // version and SDK snapshot before/after, never relabel current data as history.
    return scratch(async (directory) => {
      const output = await runNative(command, [], directory, JSON.stringify({ AccessToken: accessToken,
        HubId: project.hub, ProjectId: project.project, FileId: ref.fileId, RevisionId: ref.revisionId }) + '\n', signal);
      const result = object(JSON.parse(output.trim()));
      if (result.revisionId !== ref.revisionId) throw new ServiceError(502, 'revision-mismatch', 'Exchange changed during export. Refresh and retry.');
      const bytes = await readArtifact(directory, text(result.path), maxBytes);
      if (!Buffer.from(bytes.subarray(0, 64)).toString().includes('ISO-10303-21')) throw new ServiceError(502, 'invalid-ifc', 'The exchange exporter returned an invalid IFC file.');
      return { revisionId: ref.revisionId, format: 'ifc', bytes };
    });
  } };
}
