/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD-pattern example generator (IDS-114): property tests against the
 * translator. Every "matching" example must match and every "non-matching"
 * one must not, both under the shared translator compiled the way the
 * checker compiles it and under `matchConstraint` itself. Coverage is
 * measured on the patterns of buildingSMART's IDS corpus and on 2,000
 * random patterns that are satisfiable by construction.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIDS } from '../parser/xml-parser.js';
import type { IDSConstraint } from '../types.js';
import { matchConstraint } from './index.js';
import { generatePatternExamples } from './xsd-examples.js';
import { parseXsdRegex } from './xsd-regex-ast.js';
import { translateXsdRegex } from './xsd-regex.js';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '__corpus__', 'buildingsmart-ids');

/**
 * The translator compiled as the checker compiles it: anchored, under `u`,
 * and without `u` when JS refuses the pattern there (e.g. `\-` outside a
 * class), as `buildPatternRegex` does.
 */
function translated(pattern: string): RegExp {
  const source = `^(?:${translateXsdRegex(pattern).pattern})$`;
  try {
    return new RegExp(source, 'u');
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return new RegExp(source);
  }
}

function verify(pattern: string, matching: string[], nonMatching: string[]): void {
  const re = translated(pattern);
  const c: IDSConstraint = { type: 'pattern', pattern };
  for (const s of matching) {
    expect(re.test(s), `${pattern} ⊨ ${JSON.stringify(s)}`).toBe(true);
    expect(matchConstraint(c, s)).toBe(true);
  }
  for (const s of nonMatching) {
    expect(re.test(s), `${pattern} ⊭ ${JSON.stringify(s)}`).toBe(false);
    expect(matchConstraint(c, s)).toBe(false);
  }
}

function corpusPatterns(): string[] {
  const out = new Set<string>();
  const visit = (c: IDSConstraint | undefined) => {
    if (!c) return;
    if (c.type === 'pattern') out.add(c.pattern);
    for (const s of c.and ?? []) visit(s);
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ids') && !name.startsWith('invalid-')) {
        for (const spec of parseIDS(readFileSync(path, 'utf8')).specifications) {
          for (const f of [...spec.applicability.facets, ...spec.requirements.map((r) => r.facet)]) {
            for (const v of Object.values(f)) if (v && typeof v === 'object' && 'type' in v) visit(v as IDSConstraint);
            if (f.type === 'partOf') visit(f.entity?.name);
          }
        }
      }
    }
  };
  walk(CORPUS);
  return [...out];
}

/** Random XSD patterns, satisfiable by construction (no empty classes). */
function randomPattern(rng: () => number, depth = 0): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  const atoms = [
    () => pick(['A', 'b', '7', '_', 'É', ' ', '-']),
    () => `\\${pick(['.', '-', '(', '[', '+', '?', '|', '\\'])}`,
    () => pick(['[a-z]', '[A-Z0-9]', '[^0-9]', '[a-z-[aeiou]]', '[\\d.]', '[ÄÖÜ]', '[^\\s]']),
    () => pick(['\\d', '\\w', '\\s', '\\i', '\\c', '\\D', '\\W', '\\S', '\\p{Lu}', '\\p{Nd}', '.']),
    () => (depth < 2 ? `(${randomPattern(rng, depth + 1)}${rng() < 0.3 ? `|${randomPattern(rng, depth + 1)}` : ''})` : 'x'),
  ];
  const quant = () => pick(['', '', '', '?', '*', '+', '{2}', '{1,3}', '{0,}']);
  return Array.from({ length: 1 + Math.floor(rng() * 4) }, () => `${pick(atoms)()}${quant()}`).join('');
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('generatePatternExamples', () => {
  it('gives the simplest match first and near misses after', () => {
    const r = generatePatternExamples('EI[0-9]{2}', { count: 4 });
    expect(r.supported).toBe(true);
    expect(r.matching[0]).toBe('EI00');
    expect(r.matching).toHaveLength(4);
    expect(r.nonMatching.length).toBe(4);
    verify('EI[0-9]{2}', r.matching, r.nonMatching);
    expect(r.nonMatching.some((s) => s.length === 4)).toBe(true);
  });

  it('is deterministic per seed', () => {
    expect(generatePatternExamples('[A-Z]{2}-\\d+', { seed: 7 })).toEqual(generatePatternExamples('[A-Z]{2}-\\d+', { seed: 7 }));
  });

  it('is never wrong on the corpus patterns, and finds examples for every one', () => {
    const patterns = corpusPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(14);
    for (const p of patterns) {
      const r = generatePatternExamples(p);
      verify(p, r.matching, r.nonMatching);
      expect(r.matching.length, p).toBeGreaterThan(0);
      expect(r.nonMatching.length, p).toBeGreaterThan(0);
    }
  });

  it('is never wrong on 2000 random patterns and finds a match for at least 99% of them', () => {
    const rng = seeded(0x114);
    let found = 0;
    const total = 2000;
    for (let k = 0; k < total; k++) {
      const p = randomPattern(rng);
      expect(() => parseXsdRegex(p), p).not.toThrow();
      const r = generatePatternExamples(p, { seed: k, count: 3 });
      verify(p, r.matching, r.nonMatching);
      if (r.matching.length) found++;
    }
    expect(found / total).toBeGreaterThanOrEqual(0.99);
  });

  it('reports patterns it cannot check instead of guessing', () => {
    expect(generatePatternExamples('[a-z').supported).toBe(false);
    expect(generatePatternExamples('a{3,1}')).toMatchObject({ supported: false, matching: [] });
    const guarded = generatePatternExamples('(a+)+b');
    expect(guarded.supported).toBe(false);
    expect(guarded.reason.length).toBeGreaterThan(0);
  });
});
