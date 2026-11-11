/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An independent STEP reader for the structural coverage oracles. It is the
 * ground truth the probes compare the product's read model against, so it
 * shares no code with the parser under test.
 *
 * Why not `tests/modelling-parity/ui/lib/step.mjs`: on the corpus that reader
 * drops 33 of 188 records of `ifcopenshell/structural_analysis_curve.ifc` and
 * rejects typed values written with a space (`IFCPLANEANGLEMEASURE (0.017)`),
 * which every AxisVM export here uses. This one splits statements on top-level
 * `;` outside strings and allows whitespace between any two tokens.
 *
 * Values: number, string (decoded), `{ ref }`, `{ enum }`, `{ type, value }`,
 * arrays, `null` for `$`, `'*'` for `*`.
 */

/** Decode STEP string escapes: `''`, `\X2\..\X0\`, `\X\hh`, `\S\c`. */
export function decodeStepString(raw) {
  return raw
    .replace(/\\X2\\([0-9A-F]+?)\\X0\\/gi, (_, hex) => String.fromCharCode(...hex.match(/.{4}/g).map((h) => parseInt(h, 16))))
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

function parseValue(text, start) {
  let i = start;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '(') {
      i++;
      const list = [];
      ws();
      while (text[i] !== ')') {
        list.push(value());
        ws();
        if (text[i] === ',') i++;
        else if (text[i] !== ')') throw new Error(`STEP: expected , or ) at ${i}`);
      }
      i++;
      return list;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= text.length) throw new Error('STEP: unterminated string');
        if (text[i] === "'" && text[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (text[i] === "'") { i++; break; }
        s += text[i++];
      }
      return decodeStepString(s);
    }
    if (c === '#') {
      const m = /^#(\d+)/.exec(text.slice(i, i + 24));
      i += m[0].length;
      return { ref: Number(m[1]) };
    }
    if (c === '$') { i++; return null; }
    if (c === '*') { i++; return '*'; }
    if (c === '.') {
      const end = text.indexOf('.', i + 1);
      const e = text.slice(i + 1, end);
      i = end + 1;
      return { enum: e };
    }
    if (c === '"') { const end = text.indexOf('"', i + 1); const s = text.slice(i + 1, end); i = end + 1; return { binary: s }; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 80));
    if (word) {
      i += word[0].length;
      ws();
      const inner = value();
      return { type: word[0].toUpperCase(), value: Array.isArray(inner) && inner.length === 1 ? inner[0] : inner };
    }
    const n = /^[-+]?(\d+\.?\d*|\.\d+)([Ee][-+]?\d+)?/.exec(text.slice(i, i + 40));
    if (n) { i += n[0].length; return Number(n[0]); }
    throw new Error(`STEP: cannot parse value at ${i}: ${text.slice(i, i + 30)}`);
  };
  return value();
}

/** Split the DATA section into statements on `;` outside strings. */
function statements(data) {
  const out = [];
  let from = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "'") {
      for (i++; i < data.length; i++) {
        if (data[i] === "'" && data[i + 1] === "'") { i++; continue; }
        if (data[i] === "'") break;
      }
    } else if (c === '/' && data[i + 1] === '*') {
      const end = data.indexOf('*/', i + 2);
      i = end === -1 ? data.length : end + 1;
    } else if (c === ';') {
      out.push(data.slice(from, i));
      from = i + 1;
    }
  }
  return out;
}

/** Parse a STEP file: `{ schema, entities: Map<id, {id, type, args}>, of(type), get(refOrId), count(type) }`. */
export function readStep(text) {
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text)?.[1] ?? null;
  const start = text.search(/\bDATA\s*;/);
  if (start === -1) throw new Error('STEP: no DATA section');
  const data = text.slice(text.indexOf(';', start) + 1);
  const entities = new Map();
  const byType = new Map();
  for (const st of statements(data)) {
    const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/.exec(st);
    if (!m) continue;
    const args = parseValue(st, m[0].length - 1);
    const entity = { id: Number(m[1]), type: m[2].toUpperCase(), args };
    entities.set(entity.id, entity);
    if (!byType.has(entity.type)) byType.set(entity.type, []);
    byType.get(entity.type).push(entity);
  }
  const of = (type) => byType.get(String(type).toUpperCase()) ?? [];
  return {
    schema,
    entities,
    of,
    get: (ref) => entities.get(ref && typeof ref === 'object' ? ref.ref : ref),
    count: (type) => of(type).length,
  };
}
