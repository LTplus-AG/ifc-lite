/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.ifcZIP` container support (issues #1494, #1781).
 *
 * The buildingSMART IFC container format is a plain zip archive wrapping a
 * single `.ifc`/`.ifcxml` model file, optionally alongside referenced
 * resources. `unwrapIfcZip` unwraps just the model so the rest of the
 * pipeline (parseAuto, detectFormat, the various loaders) sees ordinary
 * model bytes and never has to know zip existed;
 * `unwrapIfcZipWithResources` additionally surfaces sibling raster images —
 * the files `IfcImageTexture.URLReference` points at (#1781) — so the viewer
 * can resolve textures without re-opening the archive.
 */

import JSZip from 'jszip';

/** Little-endian `PK\x03\x04` — the local-file-header signature every
 *  standard zip archive starts with (including .ifcZIP/.bcfzip/.docx/...). */
const ZIP_MAGIC = 0x04034b50;

/** True if `buffer` starts with the zip local-file-header signature. */
export function isZipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === ZIP_MAGIC;
}

/**
 * `isZipBuffer` for a `Uint8Array` view — reads the magic bytes directly off
 * the view without materializing an ArrayBuffer, so the common non-zip load
 * pays no allocation at all (see `unwrapIfcZipView`).
 */
function isZipView(view: Uint8Array): boolean {
  return (
    view.byteLength >= 4 &&
    view[0] === 0x50 && // 'P'
    view[1] === 0x4b && // 'K'
    view[2] === 0x03 &&
    view[3] === 0x04
  );
}

/** Case-insensitive match for a model file entry inside the archive. */
const MODEL_ENTRY_RE = /\.(ifc|ifcxml)$/i;

/**
 * Ceiling on the DECOMPRESSED size of the extracted model entry (4 GiB).
 * Generous enough for any real IFC file this project handles (the desktop
 * native fast path already targets 500 MB+ source files), but bounds a
 * maliciously crafted archive that declares a tiny compressed size and a
 * huge uncompressed one (a zip bomb) from exhausting memory — `unwrapIfcZip`
 * runs unconditionally on every CLI/MCP/viewer load, including
 * server-adjacent (MCP) processes.
 */
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * If `buffer` is a zip container, unwrap it and return the bytes of the
 * single `.ifc`/`.ifcxml` entry inside. Returns `buffer` UNCHANGED when it's
 * not a zip (cheap magic-byte check, no-op for every ordinary IFC/IFCX/GLB
 * file) — so callers can call this unconditionally on every load.
 *
 * Throws if the archive contains zero or more than one candidate model
 * entry — silently picking one would risk loading the wrong model — or if
 * the entry's declared uncompressed size exceeds a sane ceiling (zip-bomb
 * guard, checked from the central-directory metadata, before decompressing).
 * Referenced resources (textures, documents) inside the container are not
 * extracted; only the model entry's bytes are returned.
 */
export async function unwrapIfcZip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  return unwrapIfcZipWithLimit(buffer, MAX_UNCOMPRESSED_BYTES);
}

/**
 * `unwrapIfcZip` with an explicit uncompressed-size ceiling. Split out so
 * tests can exercise the zip-bomb guard with a small limit instead of
 * needing a multi-gigabyte fixture — not part of the public API, import
 * directly from `./ifczip.js`.
 */
export async function unwrapIfcZipWithLimit(
  buffer: ArrayBuffer,
  maxUncompressedBytes: number,
): Promise<ArrayBuffer> {
  if (!isZipBuffer(buffer)) return buffer;
  const { entry } = await openZipModelEntry(buffer, maxUncompressedBytes);
  return entry.async('arraybuffer');
}

/** Sibling raster-image entries `IfcImageTexture.URLReference` can point at. */
const IMAGE_ENTRY_RE = /\.(png|jpe?g)$/i;

/**
 * Ceiling on ONE decompressed sibling image (256 MiB — a 16384² RGBA PNG is
 * ~1 GiB decoded but well under this encoded; real texture JPEGs are a few
 * MB). An oversized entry is SKIPPED, not fatal: the model must still load,
 * it just renders that texture with its style colour.
 */
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

/**
 * Aggregate ceilings across ALL retained sibling images (512 MiB / 256
 * entries): a hostile archive stuffed with thousands of per-entry-legal
 * images must not exhaust memory through sheer count. Once either budget is
 * spent, further images are skipped (model load unaffected). Real textured
 * exports ship a handful of images.
 */
const MAX_TOTAL_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_ENTRIES = 256;

/** Result of `unwrapIfcZipWithResources`. */
export interface IfcZipContents {
  /** The single model entry's bytes (or the input unchanged for non-zip). */
  model: ArrayBuffer;
  /**
   * Sibling raster images keyed by LOWERCASED basename (path and case are
   * stripped so `Textures/Wood.JPG` resolves a `wood.jpg` reference and vice
   * versa). Empty for non-zip input and archives without images.
   */
  resources: Map<string, Uint8Array>;
}

/**
 * `unwrapIfcZip` variant that ALSO extracts sibling raster images (#1781) —
 * the packaging convention for textured IFC (`IfcImageTexture.URLReference`
 * is a relative filename, the image ships next to the `.ifc` inside the
 * `.ifcZIP`). Non-zip input returns unchanged bytes and an empty map, so
 * callers can invoke this unconditionally like `unwrapIfcZip`.
 */
export async function unwrapIfcZipWithResources(
  buffer: ArrayBuffer,
): Promise<IfcZipContents> {
  if (!isZipBuffer(buffer)) return { model: buffer, resources: new Map() };
  const { zip, entry } = await openZipModelEntry(buffer, MAX_UNCOMPRESSED_BYTES);

  const resources = new Map<string, Uint8Array>();
  let totalImageBytes = 0;
  for (const res of Object.values(zip.files)) {
    if (res.dir || !IMAGE_ENTRY_RE.test(res.name)) continue;
    if (resources.size >= MAX_IMAGE_ENTRIES) break;
    const size = declaredUncompressedSize(res);
    if (typeof size === 'number' && size > MAX_IMAGE_BYTES) continue;
    const basename = res.name.split('/').pop()?.toLowerCase();
    if (!basename) continue;
    // First entry wins on a (pathological) basename collision — matching the
    // deterministic first-wins convention used across the style indexes.
    if (resources.has(basename)) continue;
    const bytes = await res.async('uint8array');
    // Enforce the aggregate budget on REAL decompressed sizes (the central-
    // directory declaration is advisory and absent on some writers).
    if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
    if (totalImageBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) break;
    totalImageBytes += bytes.byteLength;
    resources.set(basename, bytes);
  }

  return { model: await entry.async('arraybuffer'), resources };
}

/** JSZip's central-directory uncompressed size — internal field, so read
 *  defensively: a future JSZip dropping it just skips the size guard. */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  return (entry as unknown as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize;
}

/** Open the archive, locate the SINGLE model entry, and run the zip-bomb
 *  guard. Shared by `unwrapIfcZipWithLimit` / `unwrapIfcZipWithResources`. */
async function openZipModelEntry(
  buffer: ArrayBuffer,
  maxUncompressedBytes: number,
): Promise<{ zip: JSZip; entry: JSZip.JSZipObject }> {
  // Wrap in a Uint8Array rather than passing `buffer` directly: some callers
  // (the browser streaming path) hand us a SharedArrayBuffer-backed view for
  // large files, which JSZip doesn't declare support for but a Uint8Array
  // over it reads identically to one over a plain ArrayBuffer.
  const zip = await JSZip.loadAsync(new Uint8Array(buffer));
  const candidates = Object.values(zip.files).filter(
    (entry) => !entry.dir && MODEL_ENTRY_RE.test(entry.name),
  );

  if (candidates.length === 0) {
    throw new Error(
      'This .ifcZIP archive contains no .ifc/.ifcxml entry — nothing to parse.',
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `This .ifcZIP archive contains ${candidates.length} model files ` +
      `(${candidates.map((c) => c.name).join(', ')}) — expected exactly one.`,
    );
  }

  const entry = candidates[0];
  // Zip-bomb guard from the central-directory metadata, before decompressing.
  const uncompressedSize = declaredUncompressedSize(entry);
  if (typeof uncompressedSize === 'number' && uncompressedSize > maxUncompressedBytes) {
    throw new Error(
      `This .ifcZIP archive's model entry "${entry.name}" declares an uncompressed ` +
      `size of ${(uncompressedSize / (1024 * 1024 * 1024)).toFixed(1)} GiB, over the ` +
      `${(maxUncompressedBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB limit — refusing to decompress.`,
    );
  }

  return { zip, entry };
}

/**
 * `unwrapIfcZip` for a Node `Buffer`/`Uint8Array` view (CLI/MCP loaders):
 * handles the ArrayBuffer-slice dance for a view that may not span its whole
 * backing buffer, so callers just wrap the result in `Buffer.from(...)`.
 */
export async function unwrapIfcZipView(view: Uint8Array): Promise<ArrayBuffer> {
  // Cheap magic-byte check on the view FIRST — the common case is an ordinary
  // non-zip IFC/IFCX/GLB file, and copying the whole (possibly multi-GB)
  // backing buffer just to hand it back unchanged is a wasted full-file
  // allocation on every CLI/MCP load.
  if (!isZipView(view)) {
    // Not a zip: return an ArrayBuffer spanning exactly the view. When the
    // view already covers its whole backing buffer (Node's dedicated
    // allocation for any file over ~4 KB — i.e. every real IFC), hand it back
    // with no copy; only the rare sub-range view needs a slice.
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      return view.buffer as ArrayBuffer;
    }
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }

  // It's a zip container — materialize the exact bytes and let unwrapIfcZip
  // open the archive.
  const arrayBuffer = view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
  return unwrapIfcZip(arrayBuffer);
}
