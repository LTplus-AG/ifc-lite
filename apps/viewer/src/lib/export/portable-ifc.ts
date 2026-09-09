/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { zip, zipSync, strToU8, type Zippable } from 'fflate';
import { modelAppearanceAssets } from '../appearance/model-assets.js';

export interface PortableIfcArtifact { content: string | Uint8Array; ext: 'ifc' | 'ifczip'; mime: string }
interface Resources {
  exportResources(modelId: string): { modelPath?: string; resources: Map<string, Uint8Array> };
}
function safePath(path: string): string {
  // Archive paths deliberately reject ASCII control characters as unsafe names.
  // eslint-disable-next-line no-control-regex
  if (!path || path.startsWith('/') || /[\\\\\u0000-\u001f\u007f:]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Cannot package this texture archive: it contains an unsafe relative path. Rename its model/image entries and reload.');
  }
  return path;
}
function entries(modelId: string, content: string | Uint8Array, source: Resources): Zippable | null {
  const archive = source.exportResources(modelId);
  if (!archive.resources.size) return null;
  // STEP serialization keeps the source directory, never its IFCXML suffix.
  const modelPath = safePath(archive.modelPath ?? 'model.ifc').replace(/\.ifcxml$/i, '.ifc');
  const result: Zippable = Object.create(null);
  result[modelPath] = [typeof content === 'string' ? strToU8(content) : content, { level: 6 }];
  for (const [path, bytes] of archive.resources) {
    const name = safePath(path);
    if (name === modelPath) throw new Error('A texture resource collides with the IFC model entry. Rename the image and reload.');
    result[name] = [bytes, { level: 0 }]; // Original JPEG/PNG bytes are already compressed.
  }
  return result;
}
/** Synchronous SDK export retains its existing string | Uint8Array contract. */
export function packagePortableIfc(modelId: string, content: string | Uint8Array, source: Resources = modelAppearanceAssets): PortableIfcArtifact {
  const files = entries(modelId, content, source);
  return files ? { content: zipSync(files), ext: 'ifczip', mime: 'application/zip' } : { content, ext: 'ifc', mime: 'text/plain' };
}
/** Normal viewer exports compress STEP off the main thread. */
export async function packagePortableIfcAsync(modelId: string, content: string | Uint8Array, source: Resources = modelAppearanceAssets): Promise<PortableIfcArtifact> {
  const files = entries(modelId, content, source);
  if (!files) return { content, ext: 'ifc', mime: 'text/plain' };
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, (error, result) => error ? reject(error) : resolve(result));
  });
  return { content: bytes, ext: 'ifczip', mime: 'application/zip' };
}
/** Merge cannot preserve model-relative image identities without URL remapping. */
export function assertPortableMergeSupported(modelIds: Iterable<string>): void {
  for (const id of modelIds) {
    if (modelAppearanceAssets.exportResources(id).resources.size) {
      throw new Error('Merged textured IFC export needs texture URL remapping. Export each model separately as IFCZIP to preserve its appearance.');
    }
  }
}
/** Match archive bytes before choosing a filename; never label IFCZIP as STEP. */
export function portableIfcDownload(content: string | Uint8Array, filename: string, mime: string): { filename: string; mime: string } {
  const archive = content instanceof Uint8Array && content[0] === 0x50 && content[1] === 0x4b && content[2] === 3 && content[3] === 4;
  return archive
    ? { filename: filename.replace(/\.ifc$/i, '.ifczip'), mime: 'application/zip' }
    : { filename, mime };
}
