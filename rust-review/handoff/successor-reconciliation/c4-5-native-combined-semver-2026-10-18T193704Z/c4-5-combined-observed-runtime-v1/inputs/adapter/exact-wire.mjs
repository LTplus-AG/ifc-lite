// Pure standard JS only. No producer imports. Bytes remain authoritative as well
// as readable values: comparison retains both, including NaN payload bits.
import assert from 'node:assert/strict';
const constructors = { Uint8Array, Uint32Array, Float32Array, Float64Array, BigUint64Array };
export const absent = Object.freeze({ undefined: true });
export const isAbsent = v => v?.undefined === true && Object.keys(v).length === 1;
export function exact(v) {
  if (v === undefined) return { ...absent };
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)))
    return { number: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'bigint') return { bigint: v.toString() };
  if (ArrayBuffer.isView(v)) {
    assert.ok(Object.hasOwn(constructors, v.constructor.name), 'unreviewed typed-array constructor');
    const b = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return { typedArray: v.constructor.name, length: v.length, byteLength: b.length,
      bytesBase64: b.toString('base64'), values: Array.from(v, exact) };
  }
  if (v instanceof ArrayBuffer) return { arrayBuffer: Buffer.from(v).toString('base64'), byteLength: v.byteLength };
  if (Array.isArray(v)) return v.map(exact);
  if (v instanceof Map) return { map: [...v].map(([k, x]) => [exact(k), exact(x)]) };
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map(k => [k, exact(v[k])]));
  return v;
}
function scalar(v) {
  if (v?.number) {
    assert.deepEqual(Object.keys(v), ['number']);
    assert.ok(['-0', 'NaN', 'Infinity', '-Infinity'].includes(v.number));
    return v.number === '-0' ? -0 : Number(v.number);
  }
  if (v?.bigint !== undefined) {
    assert.deepEqual(Object.keys(v), ['bigint']);
    assert.match(v.bigint, /^(0|[1-9][0-9]*)$/);
    return BigInt(v.bigint);
  }
  assert.ok(typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0), 'noncanonical readable number');
  return v;
}
export function decodeTyped(w, expectedType) {
  assert.ok(w && Object.hasOwn(constructors, w.typedArray), 'missing/unknown typed-array type');
  if (expectedType) assert.equal(w.typedArray, expectedType, 'typed-array type mismatch');
  const C = constructors[w.typedArray];
  assert.ok(Number.isSafeInteger(w.length) && w.length >= 0, 'logical length');
  assert.equal(w.byteLength, w.length * C.BYTES_PER_ELEMENT, 'type width/length discrepancy');
  assert.equal(typeof w.bytesBase64, 'string');
  const bytes = Buffer.from(w.bytesBase64, 'base64');
  assert.equal(bytes.toString('base64'), w.bytesBase64, 'noncanonical base64');
  assert.equal(bytes.length, w.byteLength, 'byte length discrepancy');
  assert.ok(Array.isArray(w.values)); assert.equal(w.values.length, w.length, 'readable length discrepancy');
  // Frozen producer host is little-endian. Refuse a different host rather than reinterpret bytes.
  assert.equal(new Uint8Array(new Uint32Array([1]).buffer)[0], 1, 'unsupported host byte order');
  const copied = Uint8Array.from(bytes);
  const values = new C(copied.buffer);
  for (let i = 0; i < values.length; i++) {
    const readable = scalar(w.values[i]);
    assert.ok(Object.is(values[i], readable), `wire/readable mismatch at ${i}`);
  }
  return values;
}
export function validateExact(v) {
  if (!v || typeof v !== 'object') return;
  if (Object.hasOwn(v, 'typedArray')) { decodeTyped(v); return; }
  if (Object.hasOwn(v, 'arrayBuffer')) {
    const b = Buffer.from(v.arrayBuffer, 'base64');
    assert.equal(b.toString('base64'), v.arrayBuffer); assert.equal(b.length, v.byteLength); return;
  }
  if (Object.hasOwn(v, 'getterError') || Object.hasOwn(v, 'missingGetter') || Object.hasOwn(v, 'error'))
    throw new Error('INCOMPLETE: error/missing getter in raw evidence');
  for (const child of Object.values(v)) validateExact(child);
}
