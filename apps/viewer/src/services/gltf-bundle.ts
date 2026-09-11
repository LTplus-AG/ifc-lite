/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** 12-byte GLB header plus the JSON and BIN chunk headers. */
const GLB_FRAME_BYTES = 28;

/** Bounds for one packed bundle; the viewer ships the defaults. */
export interface GltfBundleLimits {
  readonly maxResourceCount: number;
  /** Cap on the finished GLB, so also on every byte read to build it. */
  readonly maxBundleBytes: number;
}

export const DEFAULT_GLTF_BUNDLE_LIMITS: GltfBundleLimits = { maxResourceCount: 256, maxBundleBytes: 512 * 1024 * 1024 };

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

function formatLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

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

/**
 * Cumulative size guard over the GLB being built. `reserve` runs before a
 * sidecar is read, so an oversized file is refused by its `size` alone and
 * never reaches memory; the JSON chunk is estimated from the document file
 * until the exact chunk exists.
 */
class BundleBudget {
  private packed = 0;
  constructor(private readonly limit: number, private readonly documentBytes: number) {}
  reserve(bytes: number, what: string): void {
    if (GLB_FRAME_BYTES + pad4(this.documentBytes) + this.packed + pad4(bytes) > this.limit) {
      throw new Error(`glTF bundle exceeds the ${formatLimit(this.limit)} limit at “${what}”.`);
    }
  }
  /** Record appended BIN bytes and return their padded offset. */
  commit(bytes: number): number {
    const offset = this.packed;
    this.packed = pad4(offset + bytes);
    return offset;
  }
  /** Padded length of everything committed so far: the BIN chunk length. */
  get length(): number { return this.packed; }
  fitsExactly(glbBytes: number): boolean { return glbBytes <= this.limit; }
}

async function externalBytes(uri: string, files: Map<string, File[]>, budget: BundleBudget): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const embedded = decodeDataUri(uri);
  if (embedded) { budget.reserve(embedded.bytes.byteLength, uri.slice(0, 32)); return embedded; }
  const path = safeUriPath(uri), exact = files.get(path);
  const matches = exact?.length ? exact : files.get(path.split('/').pop() ?? '');
  if (!matches?.length) throw new Error(`glTF bundle is missing “${path}”. Select the .gltf, .bin and texture files together.`);
  if (matches.length !== 1) throw new Error(`glTF bundle contains more than one possible “${path}” resource.`);
  const [match] = matches;
  budget.reserve(match.size, path);
  return { bytes: new Uint8Array(await match.arrayBuffer()), mimeType: match.type || undefined };
}

function imageMime(image: GltfImage, uri: string, supplied?: string): string {
  const mime = image.mimeType || supplied || (/\.png(?:$|[?#])/i.test(uri) ? 'image/png' : /\.jpe?g(?:$|[?#])/i.test(uri) ? 'image/jpeg' : '');
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error(`glTF texture “${uri}” must be PNG or JPEG.`);
  return mime;
}

/** Resolve a user-selected .gltf + local resources into the GLB consumed by the canonical loader. */
export async function packGltfBundle(documentFile: File, selectedFiles: readonly File[], limits: GltfBundleLimits = DEFAULT_GLTF_BUNDLE_LIMITS): Promise<File> {
  const budget = new BundleBudget(limits.maxBundleBytes, documentFile.size);
  budget.reserve(0, documentFile.name);
  let document: GltfDocument;
  try { document = JSON.parse(await documentFile.text()) as GltfDocument; } catch { throw new Error(`${documentFile.name}: invalid glTF JSON.`); }
  if (document.asset?.version !== '2.0') throw new Error(`${documentFile.name}: only glTF 2.0 is supported.`);
  const buffers = document.buffers ?? [];
  const images = document.images ?? [];
  if (buffers.length + images.filter(image => image.uri).length > limits.maxResourceCount) throw new Error(`glTF bundle exceeds the ${limits.maxResourceCount}-resource limit.`);
  const files = resourceIndex(selectedFiles.filter(file => file !== documentFile));
  const chunks: Uint8Array[] = [];
  const append = (bytes: Uint8Array): number => { chunks.push(bytes); return budget.commit(bytes.byteLength); };
  const bufferOffsets: number[] = [];
  for (let index = 0; index < buffers.length; index++) {
    const buffer = buffers[index];
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || !buffer.uri) throw new Error(`glTF buffer ${index} must name a bounded local or data URI resource.`);
    const { bytes } = await externalBytes(buffer.uri, files, budget);
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
    const uri = image.uri, resource = await externalBytes(uri, files, budget);
    image.bufferView = bufferViews.length;
    image.mimeType = imageMime(image, uri, resource.mimeType);
    bufferViews.push({ buffer: 0, byteOffset: append(resource.bytes), byteLength: resource.bytes.byteLength });
    delete image.uri;
  }
  const binLength = budget.length;
  document.buffers = [{ byteLength: binLength }]; document.bufferViews = bufferViews;
  const json = new TextEncoder().encode(JSON.stringify(document)), jsonLength = pad4(json.byteLength);
  const glbLength = GLB_FRAME_BYTES + jsonLength + binLength;
  // The rewritten JSON can outgrow the document it was estimated from; settle the exact size before allocating.
  if (!budget.fitsExactly(glbLength)) throw new Error(`glTF bundle exceeds the ${formatLimit(limits.maxBundleBytes)} limit at “${documentFile.name}”.`);
  const output = new Uint8Array(glbLength), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glbLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(0x20, 20, 20 + jsonLength); output.set(json, 20);
  view.setUint32(20 + jsonLength, binLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  let cursor = GLB_FRAME_BYTES + jsonLength;
  for (const chunk of chunks) { output.set(chunk, cursor); cursor = pad4(cursor + chunk.byteLength); }
  return new File([output], documentFile.name.replace(/\.gltf$/i, '.glb'), { type: 'model/gltf-binary', lastModified: documentFile.lastModified });
}

export async function resolveGltfModelFiles(files: readonly File[]): Promise<File[]> {
  const documents = files.filter(file => /\.gltf$/i.test(file.name));
  const ordinary = files.filter(file => !/\.gltf$/i.test(file.name) && !/\.(?:bin|png|jpe?g)$/i.test(file.name));
  return [...ordinary, ...await Promise.all(documents.map(file => packGltfBundle(file, files)))];
}
