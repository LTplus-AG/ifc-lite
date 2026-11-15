/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10264: decide whether uploading the original ZIP would lose viewer images.
 * Read only the end record and a bounded central directory. Unknown layouts
 * (including ZIP64/multipart) retain local admission; never inflate to decide. */
export async function archiveAllowsServer(file: File): Promise<boolean> {
  const tail = new Uint8Array(await file.slice(-65557).arrayBuffer());
  const end = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let offset = tail.length - 22;
  for (; offset >= 0; offset--) {
    if (end.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + end.getUint16(offset + 20, true) === tail.length) break;
  }
  if (offset < 0 || end.getUint16(offset + 4, true) !== 0 || end.getUint16(offset + 6, true) !== 0) return false;
  const entries = end.getUint16(offset + 10, true);
  const bytes = end.getUint32(offset + 12, true), start = end.getUint32(offset + 16, true);
  if (entries === 0 || entries === 65535 || entries !== end.getUint16(offset + 8, true) ||
      bytes > 1024 * 1024 || start === 0xffffffff || start + bytes > file.size - 22) return false;
  const directory = new Uint8Array(await file.slice(start, start + bytes).arrayBuffer());
  if (directory.length !== bytes) return false;
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  let cursor = 0, models = 0;
  for (let entry = 0; entry < entries; entry++) {
    if (cursor + 46 > bytes || view.getUint32(cursor, true) !== 0x02014b50) return false;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraEnd = cursor + 46 + nameLength + view.getUint16(cursor + 30, true);
    const next = extraEnd + view.getUint16(cursor + 32, true);
    if (next > bytes || view.getUint16(cursor + 34, true) !== 0) return false;
    // JSZip can replace the raw name from a Unicode Path extra field. Keep
    // those archives local rather than certify an image-free raw-name list.
    for (let extra = cursor + 46 + nameLength; extra < extraEnd;) {
      if (extra + 4 > extraEnd || view.getUint16(extra, true) === 0x7075) return false;
      extra += 4 + view.getUint16(extra + 2, true);
      if (extra > extraEnd) return false;
    }
    const name = new TextDecoder().decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));
    // Match the viewer parser's sibling-image and AppleDouble model policies.
    if (/\.(png|jpe?g)$/i.test(name)) return false;
    if (/\.(ifc|ifcxml)$/i.test(name) && !/(^|\/)\._[^/]*$/.test(name)) models++;
    cursor = next;
  }
  return cursor === bytes && models === 1;
}
