/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Private document wire. Use only on owned DTOs, never to enumerate adapters. */
export function packDocument(value: unknown): Uint8Array {
  const strings: string[] = [];
  const ids = new Map<string, number>();
  let bytes = new Uint8Array(1024), view = new DataView(bytes.buffer), cursor = 0;
  const room = (count: number) => {
    if (cursor + count <= bytes.length) return;
    const next = new Uint8Array(Math.max(bytes.length * 2, cursor + count));
    next.set(bytes); bytes = next; view = new DataView(bytes.buffer);
  };
  const byte = (n: number) => { room(1); bytes[cursor++] = n; };
  const word = (n: number) => { room(4); view.setUint32(cursor, n, true); cursor += 4; };
  const string = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) { id = strings.length; strings.push(s); ids.set(s, id); }
    word(id);
  };
  const write = (v: unknown) => {
    if (v == null) { byte(0); return; }
    if (typeof v === 'boolean') { byte(v ? 2 : 1); return; }
    if (typeof v === 'number') { byte(3); room(8); view.setFloat64(cursor, v, true); cursor += 8; return; }
    if (typeof v === 'string') { byte(4); string(v); return; }
    if (Array.isArray(v)) { byte(5); word(v.length); for (const child of v) write(child); return; }
    if (typeof v !== 'object') throw new TypeError('unsupported binary document value');
    const entries = Object.entries(v);
    byte(6); word(entries.length);
    for (const [key, child] of entries) { string(key); write(child); }
  };
  write(value);
  const headerLength = 4 + strings.reduce((size, s) => size + 4 + s.length * 2, 0);
  const result = new Uint8Array(headerLength + cursor);
  const header = new DataView(result.buffer);
  header.setUint32(0, strings.length, true);
  let offset = 4;
  for (const s of strings) {
    header.setUint32(offset, s.length, true); offset += 4;
    for (let i = 0; i < s.length; i++, offset += 2) header.setUint16(offset, s.charCodeAt(i), true);
  }
  result.set(bytes.subarray(0, cursor), offset);
  return result;
}

/** Typed dictionary input: avoid interning the already-interned strings again. */
export function packStrings(strings: readonly string[]): Uint8Array {
  const headerLength = 4 + strings.reduce((size, s) => size + 4 + s.length * 2, 0);
  const bytes = new Uint8Array(headerLength + 5 + strings.length * 5);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, strings.length, true);
  let offset = 4;
  for (const value of strings) {
    view.setUint32(offset, value.length, true); offset += 4;
    for (let i = 0; i < value.length; i++, offset += 2) view.setUint16(offset, value.charCodeAt(i), true);
  }
  bytes[offset++] = 5;
  view.setUint32(offset, strings.length, true); offset += 4;
  for (let i = 0; i < strings.length; i++) {
    bytes[offset++] = 4;
    view.setUint32(offset, i, true); offset += 4;
  }
  return bytes;
}

export function unpackDocument(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const word = () => { const value = view.getUint32(cursor, true); cursor += 4; return value; };
  const strings: string[] = [];
  const count = word();
  for (let i = 0; i < count; i++) {
    const length = word();
    let value = '';
    // Code-unit construction preserves lone surrogates, unlike TextDecoder.
    for (let end = cursor + length * 2; cursor < end;) {
      const units: number[] = [];
      for (const chunkEnd = Math.min(end, cursor + 8192); cursor < chunkEnd; cursor += 2) units.push(view.getUint16(cursor, true));
      value += String.fromCharCode(...units);
    }
    strings.push(value);
  }
  const readEntry = () => {
    // Entry keys are the original base key, or the head key for additions.
    // Restore from the same row indices as references, avoiding string copies.
    const key = undefined;
    const state = ['added', 'modified', 'deleted', 'unchanged'][view.getUint8(cursor++)];
    const count = view.getUint8(cursor++), changeKinds: string[] = [];
    for (let i = 0; i < count; i++) changeKinds.push(['data', 'geometry', 'container'][view.getUint8(cursor++)]);
    const base = word(), head = word(), length = word();
    const entry: { key: string | undefined; state: string; changeKinds: string[]; base?: number; head?: number; changedComponents?: string[] } = { key, state, changeKinds };
    if (base !== 0xffff_ffff) entry.base = base;
    if (head !== 0xffff_ffff) entry.head = head;
    if (length !== 0xffff_ffff) {
      entry.changedComponents = [];
      for (let i = 0; i < length; i++) entry.changedComponents.push(strings[word()]);
    }
    return entry;
  };
  const read = (): unknown => {
    switch (view.getUint8(cursor++)) {
      case 0: return null;
      case 1: return false;
      case 2: return true;
      case 3: { const value = view.getFloat64(cursor, true); cursor += 8; return value; }
      case 4: return strings[word()];
      case 5: { const length = word(), values: unknown[] = []; for (let i = 0; i < length; i++) values.push(read()); return values; }
      case 7: return readEntry();
      case 6: {
        const length = word(), entries: [string, unknown][] = [];
        for (let i = 0; i < length; i++) { const key = strings[word()]; entries.push([key, read()]); }
        // CreateDataProperty semantics, including __proto__, without descriptors.
        return Object.fromEntries(entries);
      }
      default: throw new Error('invalid binary document tag');
    }
  };
  const value = read();
  if (cursor !== bytes.length) throw new Error('trailing binary document data');
  return value;
}
