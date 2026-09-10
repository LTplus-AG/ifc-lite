/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const MAX_RESOURCE_COUNT = 256;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

interface GltfBuffer { byteLength: number; uri?: string }
interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number }
interface GltfImage { uri?: string; bufferView?: number; mimeType?: string }
interface GltfDocument {
  asset?: { version?: string };
  buffers?: GltfBuffer[];
  bufferViews?: GltfBufferView[];
  images?: GltfImage[];
  [key: string]: unknown;
}

function pad4(value: number): number { return (value + 3) & ~3; }

function safeUriPath(uri: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new Error(`glTF resource has invalid escaping: ${uri}`); }
  if (!decoded || decoded.includes('\\') || decoded.startsWith('/') || decoded.split('/').includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
    throw new Error(`glTF resource must be a local relative file: ${uri}`);
  }
  return decoded.replace(/^\.\//, '');
}

function decodeDataUri(uri: string): { bytes: Uint8Array; mimeType?: string } | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 5) throw new Error('glTF data URI is malformed');
  const header = uri.slice(5, comma), payload = uri.slice(comma + 1);
  const parts = header.split(';'), mimeType = parts[0] || undefined;
  let bytes: Uint8Array;
  if (parts.includes('base64')) {
    let binary: string;
    try { binary = atob(payload); } catch { throw new Error('glTF data URI contains invalid base64'); }
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } else {
    let text: string;
    try { text = decodeURIComponent(payload); } catch { throw new Error('glTF data URI contains invalid escaping'); }
    bytes = new TextEncoder().encode(text);
  }
  return { bytes, mimeType };
}

function resourceIndex(files: readonly File[]): Map<string, File[]> {
  const index = new Map<string, File[]>();
  for (const file of files) {
    const relative = (file.webkitRelativePath || '').replace(/^\.\//, '');
    for (const key of new Set([file.name, relative, relative.split('/').pop() ?? ''].filter(Boolean))) {
      const matches = index.get(key) ?? [];
      matches.push(file); index.set(key, matches);
    }
  }
  return index;
}

async function externalBytes(uri: string, files: Map<string, File[]>): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const embedded = decodeDataUri(uri);
  if (embedded) return embedded;
  const path = safeUriPath(uri), exact = files.get(path);
  const matches = exact?.length ? exact : files.get(path.split('/').pop() ?? '');
  if (!matches?.length) throw new Error(`glTF bundle is missing “${path}”. Select the .gltf, .bin and texture files together.`);
  if (matches.length !== 1) throw new Error(`glTF bundle contains more than one possible “${path}” resource.`);
  return { bytes: new Uint8Array(await matches[0].arrayBuffer()), mimeType: matches[0].type || undefined };
}

function imageMime(image: GltfImage, uri: string, supplied?: string): string {
  const mime = image.mimeType || supplied || (/\.png(?:$|[?#])/i.test(uri) ? 'image/png' : /\.jpe?g(?:$|[?#])/i.test(uri) ? 'image/jpeg' : '');
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error(`glTF texture “${uri}” must be PNG or JPEG.`);
  return mime;
}

/** Resolve a user-selected .gltf + local resources into the GLB consumed by the canonical loader. */
export async function packGltfBundle(documentFile: File, selectedFiles: readonly File[]): Promise<File> {
  if (documentFile.size > MAX_BUNDLE_BYTES) throw new Error('glTF document exceeds the 512 MiB bundle limit.');
  let document: GltfDocument;
  try { document = JSON.parse(await documentFile.text()) as GltfDocument; } catch { throw new Error(`${documentFile.name}: invalid glTF JSON.`); }
  if (document.asset?.version !== '2.0') throw new Error(`${documentFile.name}: only glTF 2.0 is supported.`);
  const buffers = document.buffers ?? [];
  const images = document.images ?? [];
  if (buffers.length + images.filter(image => image.uri).length > MAX_RESOURCE_COUNT) throw new Error('glTF bundle exceeds the 256-resource limit.');
  const files = resourceIndex(selectedFiles.filter(file => file !== documentFile));
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (bytes: Uint8Array): number => {
    const offset = byteLength;
    byteLength = pad4(byteLength + bytes.byteLength);
    if (byteLength > MAX_BUNDLE_BYTES) throw new Error('glTF bundle exceeds the 512 MiB limit.');
    chunks.push(bytes); return offset;
  };
  const bufferOffsets: number[] = [];
  for (let index = 0; index < buffers.length; index++) {
    const buffer = buffers[index];
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || !buffer.uri) throw new Error(`glTF buffer ${index} must name a bounded local or data URI resource.`);
    const { bytes } = await externalBytes(buffer.uri, files);
    if (bytes.byteLength < buffer.byteLength) throw new Error(`glTF buffer “${buffer.uri}” is shorter than its declared byteLength.`);
    bufferOffsets[index] = append(bytes.subarray(0, buffer.byteLength));
  }
  const bufferViews = document.bufferViews ?? [];
  for (const view of bufferViews) {
    if (!Number.isSafeInteger(view.buffer) || bufferOffsets[view.buffer] === undefined) throw new Error('glTF buffer view references a missing buffer.');
    view.byteOffset = bufferOffsets[view.buffer] + (view.byteOffset ?? 0); view.buffer = 0;
  }
  for (const image of images) {
    if (!image.uri) continue;
    const uri = image.uri, resource = await externalBytes(uri, files);
    image.bufferView = bufferViews.length;
    image.mimeType = imageMime(image, uri, resource.mimeType);
    bufferViews.push({ buffer: 0, byteOffset: append(resource.bytes), byteLength: resource.bytes.byteLength });
    delete image.uri;
  }
  const bin = new Uint8Array(byteLength);
  let cursor = 0;
  for (const chunk of chunks) { bin.set(chunk, cursor); cursor = pad4(cursor + chunk.byteLength); }
  document.buffers = [{ byteLength: bin.byteLength }]; document.bufferViews = bufferViews;
  const json = new TextEncoder().encode(JSON.stringify(document)), jsonLength = pad4(json.byteLength);
  const output = new Uint8Array(28 + jsonLength + bin.byteLength), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(json, 20);
  view.setUint32(20 + jsonLength, bin.byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true); output.set(bin, 28 + jsonLength);
  return new File([output], documentFile.name.replace(/\.gltf$/i, '.glb'), { type: 'model/gltf-binary', lastModified: documentFile.lastModified });
}

export async function resolveGltfModelFiles(files: readonly File[]): Promise<File[]> {
  const documents = files.filter(file => /\.gltf$/i.test(file.name));
  const ordinary = files.filter(file => !/\.gltf$/i.test(file.name) && !/\.(?:bin|png|jpe?g)$/i.test(file.name));
  return [...ordinary, ...await Promise.all(documents.map(file => packGltfBundle(file, files)))];
}
