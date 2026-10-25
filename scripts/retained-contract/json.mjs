// SPDX-License-Identifier: MPL-2.0
// JSON.parse alone loses duplicate members. Preflight the bounded wire text
// before parsing so escaped duplicate keys and extreme nesting fail closed too.
export function parseWire(json, maxBytes) {
  const invalid = () => { throw new Error('Retained contract: invalid JSON envelope'); };
  if (typeof json !== 'string' || Buffer.byteLength(json) > maxBytes) invalid();
  const tokens = /\s*("(?:[^"\\\u0000-\u001f]|\\[^\r\n])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,])/uy;
  const stack = [];
  let offset = 0;
  while (offset < json.length) {
    if (/^\s*$/u.test(json.slice(offset))) break;
    tokens.lastIndex = offset;
    const match = tokens.exec(json);
    if (!match) invalid();
    offset = tokens.lastIndex;
    const token = match[1];
    const top = stack.at(-1);
    if (token === '{' || token === '[') {
      if (stack.length >= 32) invalid();
      stack.push({ object: token === '{', key: true, keys: new Set() });
    } else if (token === '}' || token === ']') {
      if (!top || top.object !== (token === '}')) invalid();
      stack.pop();
    } else if (token === ',') {
      if (top) top.key = true;
    } else if (token === ':') {
      if (top) top.key = false;
    } else if (top?.object && top.key && token.startsWith('"')) {
      let key;
      try { key = JSON.parse(token); } catch { invalid(); }
      if (top.keys.has(key)) invalid();
      top.keys.add(key); top.key = false;
    }
  }
  try { return JSON.parse(json); } catch { invalid(); }
}
