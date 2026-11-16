/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10264: decide whether uploading the original ZIP would lose viewer images.
 * Read only the end record and a bounded central directory. Unknown layouts
 * (including ZIP64/multipart) cannot authorize expansion from metadata or a server upload.
 * The caller may use its separate small-input, capped-local-extraction policy. Never inflate here. */
export async function inspectIfcArchiveAdmission(file: File): Promise<{ modelBytes: number; allowsServer: boolean } | null> {
  const tail = new Uint8Array(await file.slice(-65557).arrayBuffer());
  const end = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let offset = tail.length - 22;
  for (; offset >= 0; offset--) {
    if (end.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + end.getUint16(offset + 20, true) === tail.length) break;
  }
  if (offset < 0 || end.getUint16(offset + 4, true) !== 0 || end.getUint16(offset + 6, true) !== 0) return null;
  const entries = end.getUint16(offset + 10, true);
  const bytes = end.getUint32(offset + 12, true), start = end.getUint32(offset + 16, true);
  if (entries === 0 || entries === 65535 || entries !== end.getUint16(offset + 8, true) ||
      bytes > 1024 * 1024 || start === 0xffffffff || start + bytes > file.size - 22) return null;
  const directory = new Uint8Array(await file.slice(start, start + bytes).arrayBuffer());
  if (directory.length !== bytes) return null;
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  let cursor = 0, models = 0, modelBytes = 0, hasImages = false, localBytes = 0;
  for (let entry = 0; entry < entries; entry++) {
    if (cursor + 46 > bytes || view.getUint32(cursor, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraEnd = cursor + 46 + nameLength + view.getUint16(cursor + 30, true);
    const next = extraEnd + view.getUint16(cursor + 32, true);
    if (next > bytes || view.getUint16(cursor + 34, true) !== 0 ||
        [20, 24, 42].some(field => view.getUint32(cursor + field, true) === 0xffffffff)) return null;
    // JSZip can replace the raw name from a Unicode Path extra field. Keep
    // those archives unadmitted rather than certify an image-free raw-name list.
    for (let extra = cursor + 46 + nameLength; extra < extraEnd;) {
      if (extra + 4 > extraEnd || [0x0001, 0x7075].includes(view.getUint16(extra, true))) return null;
      extra += 4 + view.getUint16(extra + 2, true);
      if (extra > extraEnd) return null;
    }
    // JSZip uses local-header names. Certify them under a separate 1 MiB metadata budget.
    const localStart = view.getUint32(cursor + 42, true);
    if (localStart + 30 > start || (localBytes += 30) > 1024 * 1024) return null;
    const localHead = await file.slice(localStart, localStart + 30).arrayBuffer();
    if (localHead.byteLength !== 30) return null;
    const local = new DataView(localHead), localNameLength = local.getUint16(26, true), localExtraLength = local.getUint16(28, true);
    if (local.getUint32(0, true) !== 0x04034b50 || localNameLength !== nameLength ||
        localStart + 30 + localNameLength + localExtraLength > start ||
        (localBytes += localNameLength + localExtraLength) > 1024 * 1024) return null;
    const localFields = new Uint8Array(await file.slice(localStart + 30, localStart + 30 + localNameLength + localExtraLength).arrayBuffer());
    if (localFields.length !== localNameLength + localExtraLength ||
        !localFields.subarray(0, nameLength).every((byte, index) => byte === directory[cursor + 46 + index])) return null;
    const extras = new DataView(localFields.buffer, localFields.byteOffset, localFields.byteLength);
    for (let extra = localNameLength; extra < localFields.length;) {
      if (extra + 4 > localFields.length || [0x0001, 0x7075].includes(extras.getUint16(extra, true))) return null;
      extra += 4 + extras.getUint16(extra + 2, true);
      if (extra > localFields.length) return null;
    }
    const name = new TextDecoder().decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));
    // Match the viewer parser's sibling-image and AppleDouble model policies.
    if (/\.(png|jpe?g)$/i.test(name)) hasImages = true;
    if (/\.(ifc|ifcxml)$/i.test(name) && !/(^|\/)\._[^/]*$/.test(name)) {
      models++; modelBytes = view.getUint32(cursor + 24, true);
      if (modelBytes === 0xffffffff) return null;
    }
    cursor = next;
  }
  return cursor === bytes && models === 1 ? { modelBytes, allowsServer: !hasImages } : null;
}
