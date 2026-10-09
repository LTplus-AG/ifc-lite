/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Example strings for an XSD pattern: values that match it and values that
 * do not. Used to explain a pattern to an author ("matches: EI30, EI60;
 * does not match: E30") and to build synthetic IFC test fixtures
 * (`@ifc-lite/ids-testgen`).
 *
 * Candidates come from a random walk over the parsed pattern
 * (`xsd-regex-ast.ts`); every candidate is then checked with
 * `matchConstraint`, the exact function validation uses. So an example is
 * never wrong about the checker: a "matching" example matches, a
 * "non-matching" one does not. What the generator can miss is coverage (a
 * satisfiable pattern for which no candidate was found); the property
 * tests measure that.
 */

import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import type { IDSPatternConstraint } from '../types.js';
import { matchConstraint } from './index.js';
import { parseXsdRegex, XsdParseError, type XsdNode } from './xsd-regex-ast.js';
import { translateXsdRegex } from './xsd-regex.js';

export interface PatternExampleOptions {
  /** How many examples of each kind to return at most (default 5). */
  count?: number;
  /** Seed of the deterministic random walk (default 1). */
  seed?: number;
  /** Extra repetitions beyond a quantifier's minimum (default 3). */
  maxRepeat?: number;
}

export interface PatternExamples {
  pattern: string;
  /** Simplest first: the first entry uses every quantifier's minimum where possible. */
  matching: string[];
  /** Near misses first (one edit away from a matching example). */
  nonMatching: string[];
  /** False when the pattern cannot be checked (parse error, ReDoS guard). */
  supported: boolean;
  reason: string;
}

/**
 * Characters tried for every class: printable ASCII plus a few letters,
 * digits and symbols from other scripts, so `\d`, `\w`, `\i`, `\p{Lu}` and
 * negated classes have members to pick from.
 */
const ALPHABET: string[] = [
  ...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)),
  '\t',
  ...'ÄäÖöÜüßéèçñÅøæ€°²µ·×÷αβΩЖж中日٣३١',
];

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Characters a class source mentions, plus range midpoints. */
function mentioned(source: string): string[] {
  const out: string[] = [];
  const chars = [...source];
  chars.forEach((c, k) => {
    if (c === '-' && k > 0 && k + 1 < chars.length) {
      const lo = chars[k - 1].codePointAt(0) ?? 0;
      const hi = chars[k + 1].codePointAt(0) ?? 0;
      if (hi > lo) out.push(String.fromCodePoint(lo + Math.floor((hi - lo) / 2)), String.fromCodePoint(hi));
    }
    out.push(c);
  });
  return out;
}

class Sampler {
  private readonly members = new Map<string, string[]>();
  constructor(
    private readonly rng: Rng,
    private readonly maxRepeat: number,
  ) {}

  /** Members of a class (by its XSD source), per the shared translator. */
  membersOf(source: string): string[] {
    let list = this.members.get(source);
    if (list) return list;
    const { pattern } = translateXsdRegex(source);
    // Compiled as the checker compiles it: under `u`, else without it.
    let re: RegExp = /(?!)/;
    for (const flags of ['u', '']) {
      try {
        re = new RegExp(`^(?:${pattern})$`, flags);
        break;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    list = [...new Set([...ALPHABET, ...mentioned(source)])].filter((c) => re.test(c));
    this.members.set(source, list);
    return list;
  }

  /** One candidate for `node`; `minimal` takes each quantifier's minimum and the first branch. */
  walk(node: XsdNode, minimal: boolean): string | undefined {
    switch (node.type) {
      case 'char':
        return node.value;
      case 'class': {
        const list = this.membersOf(node.source);
        if (!list.length) return undefined;
        return minimal ? list[0] : list[Math.floor(this.rng() * list.length)];
      }
      case 'group':
        return this.walk(node.body, minimal);
      case 'alt': {
        const branch = minimal ? node.branches[0] : node.branches[Math.floor(this.rng() * node.branches.length)];
        let out = '';
        for (const item of branch) {
          const part = this.walk(item, minimal);
          if (part === undefined) return undefined;
          out += part;
        }
        return out;
      }
      case 'repeat': {
        const top = Math.min(node.max, node.min + this.maxRepeat);
        const n = minimal ? node.min : node.min + Math.floor(this.rng() * (top - node.min + 1));
        let out = '';
        for (let k = 0; k < n; k++) {
          const part = this.walk(node.node, minimal);
          if (part === undefined) return undefined;
          out += part;
        }
        return out;
      }
    }
  }
}

/** One-edit variations of `s`, near misses first. */
function variations(s: string, rng: Rng): string[] {
  const chars = [...s];
  const out: string[] = [];
  const pick = () => ALPHABET[Math.floor(rng() * ALPHABET.length)];
  for (let k = 0; k < Math.min(chars.length, 6); k++) {
    out.push([...chars.slice(0, k), pick(), ...chars.slice(k + 1)].join(''));
    out.push([...chars.slice(0, k), ...chars.slice(k + 1)].join(''));
  }
  out.push(`${s}${pick()}`, `${pick()}${s}`, `${s}${s}`, s.toLowerCase(), s.toUpperCase(), `${s} `);
  return out;
}

export function generatePatternExamples(pattern: string, options: PatternExampleOptions = {}): PatternExamples {
  const count = options.count ?? 5;
  const rng = mulberry32(options.seed ?? 1);
  const result: PatternExamples = { pattern, matching: [], nonMatching: [], supported: true, reason: '' };
  let tree: XsdNode;
  try {
    tree = parseXsdRegex(pattern);
  } catch (err) {
    if (!(err instanceof XsdParseError)) throw err;
    return { ...result, supported: false, reason: err.message };
  }
  const constraint: IDSPatternConstraint = { type: 'pattern', pattern };
  const matches = (s: string) => matchConstraint(constraint, s);
  try {
    matches('');
  } catch (err) {
    if (!(err instanceof UnsafeRegexPatternError)) throw err;
    return { ...result, supported: false, reason: err.message };
  }
  const sampler = new Sampler(rng, options.maxRepeat ?? 3);
  const seen = { true: new Set<string>(), false: new Set<string>() };
  const keep = (list: string[], s: string | undefined, want: boolean) => {
    if (s === undefined || list.length >= count) return;
    const tried = seen[`${want}`];
    if (tried.has(s)) return;
    tried.add(s);
    if (matches(s) === want) list.push(s);
  };
  keep(result.matching, sampler.walk(tree, true), true);
  for (let tries = 0; tries < count * 40 && result.matching.length < count; tries++) keep(result.matching, sampler.walk(tree, false), true);
  for (const m of result.matching) for (const v of variations(m, rng)) keep(result.nonMatching, v, false);
  for (const s of ['', '\n', 'x', '0', ' ']) keep(result.nonMatching, s, false);
  for (let tries = 0; tries < count * 40 && result.nonMatching.length < count; tries++) {
    const len = 1 + Math.floor(rng() * 8);
    keep(result.nonMatching, Array.from({ length: len }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join(''), false);
  }
  return result;
}
