/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const LANDXML_NAMESPACES = new Set([
  'http://www.landxml.org/schema/LandXML-1.0',
  'http://www.landxml.org/schema/LandXML-1.1',
  'http://www.landxml.org/schema/LandXML-1.2',
]);

export function isLandXmlFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.xml');
}

function decodeXmlHead(bytes: Uint8Array): string {
  const utf16Le = bytes.length >= 2 && (
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
  );
  if (utf16Le) {
    const start = bytes[0] === 0xff ? 2 : 0;
    return new TextDecoder('utf-16le').decode(bytes.subarray(start));
  }
  const utf16Be = bytes.length >= 2 && (
    (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
  );
  if (utf16Be) {
    const start = bytes[0] === 0xfe ? 2 : 0;
    const length = bytes.length - (bytes.length % 2);
    const swapped = new Uint8Array(length - start);
    for (let index = start; index < length; index += 2) {
      swapped[index - start] = bytes[index + 1];
      swapped[index - start + 1] = bytes[index];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  return new TextDecoder().decode(bytes);
}

/** Classify generic XML by its root QName and bound LandXML namespace. */
export function isLandXmlContent(bytes: Uint8Array): boolean {
  const head = decodeXmlHead(bytes.subarray(0, 64 * 1024 * 1024)).replace(/<!--[\s\S]*?-->/g, '');
  const root = /<(?![!?])([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\b([^>]*)>/.exec(head);
  if (!root) return false;
  const [prefix = '', localName] = root[1].includes(':')
    ? root[1].split(':', 2)
    : ['', root[1]];
  if (localName !== 'LandXML') return false;
  const namespaceName = prefix ? `xmlns:${prefix}` : 'xmlns';
  const escapedName = namespaceName.replace(':', '\\:');
  const namespace = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*["']([^"']+)["']`).exec(root[2]);
  return namespace !== null && LANDXML_NAMESPACES.has(namespace[1]);
}
