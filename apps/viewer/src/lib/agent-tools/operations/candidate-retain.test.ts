/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

const COMMITTED_PREVIEW = 'stores its candidate inside c.commit, with the committed scene preview it controls';
/** Modules whose host-owned stores never hold an undelivered candidate, and why. */
const EXEMPT: Record<string, string> = {
  'analytics-appearance.ts': COMMITTED_PREVIEW,
  'appearance-native-references.ts': COMMITTED_PREVIEW,
  'appearance-native-scan-context.ts': 'declares the scan store; appearance-native-scan.ts writes it and retains',
  'artifacts.ts': 'creates artifacts through c.commit, a committed write',
  'executor.ts': 'the job map itself: undelivered jobs run their retained undos',
};

describe('every operation that stores a host candidate registers its undo (#10918)', () => {
  it('modules with a host-owned token store retain their candidates, or are exempt for a stated reason', () => {
    const missing: string[] = [];
    for (const file of readdirSync(here).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(join(here, file), 'utf8');
      // @source-text-assertion-ok guards a convention across operation modules: a store keyed per host, filled under
      // fresh tokens, must register how to remove an entry the caller never receives (executor.ts runs it).
      const declaresStore = /new WeakMap<[^>]*,\s*(Map<string|\(\) =>)/.test(source) && /randomUUID\(\)/.test(source);
      if (!declaresStore || EXEMPT[file]) continue;
      if (!/\b(retainCandidate|c\.retain)\(/.test(source)) missing.push(file);
    }
    assert.deepEqual(missing, [], 'a candidate-storing operation that neither calls retainCandidate nor c.retain leaks its candidate when the executor refuses its result');
  });

  it('the exempt list names only modules that exist', () => {
    const files = new Set(readdirSync(here));
    assert.deepEqual(Object.keys(EXEMPT).filter(file => !files.has(file)), []);
  });
});
