/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic ranked token search for agent discovery (`viewer_operations`,
 * `viewer_commands`). Agents phrase tasks ("measure distance", "color walls"),
 * so a literal substring match finds nothing. Query and haystack are split into
 * tokens, lightly stemmed, and matched exactly, through a small BIM/viewer
 * synonym map, or by prefix. Results rank by matched-token count, then score,
 * then catalogue order, so equal queries always return equal pages.
 */

/** Text an item is searched by. Primary hits (ids, names) outrank secondary ones (descriptions, keywords). */
export interface SearchFields { primary: readonly string[]; secondary: readonly string[] }

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'with', 'by', 'my', 'me', 'i',
  'please', 'how', 'do', 'can', 'into', 'from', 'this', 'that', 'it', 'is', 'some', 'want', 'should', 'would']);
/** Acronyms and short terms whose trailing letters are not inflection. */
const UNSTEMMED = new Set(['ids', 'bcf', 'ifc', 'ifcx', 'glb', 'gltf', 'csv', 'pdf', 'svg', 'dxf', 'kmz', 'las', 'bsdd', 'xray', 'class', 'gis']);

const SYNONYMS: readonly (readonly string[])[] = [
  ['color', 'colour', 'colorize', 'colourise', 'recolor', 'paint', 'tint', 'hue'],
  ['hide', 'hidden', 'isolate', 'visibility', 'visible', 'show', 'unhide', 'ghost', 'xray'],
  ['screenshot', 'snapshot', 'capture', 'image', 'png', 'picture'],
  ['measure', 'measurement', 'distance', 'dimension', 'length'],
  ['section', 'cut', 'clip', 'clipping', 'slice'],
  ['zoom', 'frame', 'fly', 'focus', 'camera', 'fit'],
  ['select', 'selection', 'pick', 'choose'],
  ['export', 'download', 'save'],
  ['clash', 'collision', 'conflict', 'interference'],
  ['ids', 'validate', 'validation', 'check', 'verify', 'audit'],
  ['bcf', 'issue', 'topic'],
  ['wall', 'slab', 'door', 'window', 'column', 'beam', 'roof', 'stair', 'element', 'entity', 'object', 'product'],
  ['delete', 'remove', 'erase'],
  ['create', 'add', 'new', 'insert'],
  ['reset', 'clear', 'restore'],
  ['light', 'lighting', 'sun', 'shadow'],
  ['gantt', 'schedule', 'timeline', '4d'],
  ['cost', 'price', 'estimate'],
  ['property', 'pset', 'attribute', 'parameter'],
  ['drawing', 'sheet', 'elevation', '2d'],
  ['pointcloud', 'scan', 'las'],
  ['annotation', 'markup', 'note'],
];

/** Light suffix stripping. Not a real stemmer: it only has to make inflections of one word agree. */
export function stem(word: string): string {
  if (UNSTEMMED.has(word) || word.length <= 3) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  for (const suffix of ['isation', 'ization', 'ising', 'izing', 'ment', 'ing', 'ise', 'ize', 'ed']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      if (/([b-df-hj-km-np-rtv-z])\1$/.test(w) && !/(ll|ss)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/** Splits ids (`.`, `-`, `_`, camelCase) and prose into case-folded, stemmed tokens. */
export function tokenize(text: string, dropStopwords = false): string[] {
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter(word => !dropStopwords || !STOPWORDS.has(word)).map(stem);
}

const GROUP = new Map<string, number>();
SYNONYMS.forEach((words, group) => { for (const word of words) GROUP.set(stem(word), group); });

interface Indexed { primary: Set<string>; secondary: Set<string> }
const PRIMARY = 3, SECONDARY = 1, EXACT = 1, SYNONYM = 0.7, PREFIX = 0.5;

function fieldScore(token: string, field: Set<string>): number {
  if (field.has(token)) return EXACT;
  const group = GROUP.get(token);
  let best = 0;
  for (const candidate of field) {
    if (group !== undefined && GROUP.get(candidate) === group) best = Math.max(best, SYNONYM);
    else if (token.length >= 3 && candidate.length > token.length && candidate.startsWith(token)) best = Math.max(best, PREFIX);
  }
  return best;
}

/**
 * Ranks `items` against a natural-language query. An empty (or stopword-only)
 * query returns every item in its original order; items matching no token are dropped.
 */
export function rankSearch<T>(items: readonly T[], query: string, fields: (item: T) => SearchFields): T[] {
  const tokens = [...new Set(tokenize(query, true))];
  if (tokens.length === 0) return [...items];
  const scored: Array<{ item: T; index: number; matched: number; score: number }> = [];
  items.forEach((item, index) => {
    const text = fields(item);
    const indexed: Indexed = { primary: new Set(text.primary.flatMap(value => tokenize(value))),
      secondary: new Set(text.secondary.flatMap(value => tokenize(value))) };
    let matched = 0, score = 0;
    for (const token of tokens) {
      const best = Math.max(PRIMARY * fieldScore(token, indexed.primary), SECONDARY * fieldScore(token, indexed.secondary));
      if (best > 0) { matched++; score += best; }
    }
    if (matched > 0) scored.push({ item, index, matched, score });
  });
  return scored.sort((a, b) => b.matched - a.matched || b.score - a.score || a.index - b.index).map(entry => entry.item);
}
