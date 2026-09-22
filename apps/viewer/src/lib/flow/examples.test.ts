/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The example library is shipped content, so a broken example is a broken
 * release: it reaches the user as "click here to learn how this works".
 * Every one is parsed, wired against the real registry, checked for
 * availability in the browser, and checked for the things the *panel*
 * relies on (a Player input naming a real param, a declared capability
 * covering every node that needs one).
 *
 * The files are read from disk, and `examples.ts` is read as text: its
 * `?raw` imports are a Vite transform this runner does not have, so the
 * barrel can only be checked for the filenames it names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAvailability, parseFlowDocument, topologicalOrder, validateFlowWiring, type FlowDocument } from '@ifc-lite/flow';
import { hasCapability, parseCapabilities, parseCapability } from '@ifc-lite/extensions';
import { BROWSER_FEATURES, createStandardRegistry } from '@ifc-lite/flow-nodes';

const registry = createStandardRegistry();
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'examples');
const barrel = readFileSync(join(here, 'examples.ts'), 'utf-8');
const files = readdirSync(dir).filter((f) => f.endsWith('.flow.json')).sort();
const examples: Array<{ file: string; doc: FlowDocument }> = files.map((file) => ({ file, doc: parseFlowDocument(readFileSync(join(dir, file), 'utf-8')) }));

describe('flow examples', () => {
  it('examples.ts imports every file in the directory', () => {
    // A file added to the folder but not to the barrel is invisible in the
    // panel, and nothing else would fail.
    for (const file of files) assert.match(barrel, new RegExp(`./examples/${file.replace(/\./g, '\\.')}\\?raw`), `${file} is not imported by examples.ts`);
    assert.equal((barrel.match(/\.flow\.json\?raw/g) ?? []).length, files.length);
    // The menu order IS the ladder, so the barrel must list them in the
    // order their numeric prefixes imply.
    const order = [...barrel.matchAll(/\.\/examples\/([\w.-]+\.flow\.json)\?raw/g)].map((m) => m[1]);
    assert.deepEqual(order, files);
  });

  it('every id and name is unique', () => {
    assert.equal(new Set(examples.map((e) => e.doc.id)).size, examples.length);
    assert.equal(new Set(examples.map((e) => e.doc.name)).size, examples.length);
  });

  for (const { file, doc } of examples) {
    describe(file, () => {
      it('wires against the standard registry', () => {
        assert.deepEqual(validateFlowWiring(doc, registry), []);
        topologicalOrder(doc);
      });

      it('carries a description and at least one output', () => {
        assert.ok((doc.description ?? '').length > 40, 'an example without prose is not an example');
        assert.ok(doc.outputs.length > 0, 'a run with nothing to show is not explorable');
      });

      it('every node runs or no-ops in the browser', () => {
        for (const a of checkAvailability(doc, registry, BROWSER_FEATURES)) {
          assert.ok(a.status === 'ok' || a.status === 'noop', `${a.nodeId}: ${a.status} — ${a.reasons.join('; ')}`);
        }
      });

      it('declares every capability its nodes require', () => {
        const parsed = parseCapabilities(doc.capabilities);
        assert.ok(parsed.ok, `malformed capabilities: ${parsed.ok ? '' : parsed.errors.map((e) => e.message).join('; ')}`);
        if (!parsed.ok) return;
        for (const node of doc.nodes) {
          for (const raw of registry.get(node.type)?.capabilities ?? []) {
            // The node's declaration can be a wildcard (`model.mutate:*`)
            // while the grant names the pset it actually writes, so a
            // mutate node is satisfied by any grant in the same scope.
            const wanted = parseCapability(raw);
            assert.ok(wanted.ok, raw);
            if (!wanted.ok) continue;
            const covered: boolean = raw.endsWith(':*')
              ? parsed.value.some((g) => g.scope === wanted.value.scope && g.action === wanted.value.action)
              : hasCapability(parsed.value, wanted.value);
            assert.ok(covered, `${node.id} (${node.type}) needs ${raw}, which "${doc.capabilities.join(' ')}" does not grant`);
          }
        }
      });

      it('every Player input names a real parameter of its node', () => {
        for (const input of doc.inputs) {
          const node = doc.nodes.find((n) => n.id === input.nodeId);
          assert.ok(node, input.nodeId);
          assert.ok(registry.get(node!.type)?.params.some((p) => p.name === input.param), `${input.nodeId}.${input.param}`);
        }
      });

      it('every node is reachable: nothing is wired to nowhere', () => {
        // A stray node in an example reads as a mistake the user should copy.
        const wired = new Set<string>();
        for (const e of doc.edges) { wired.add(e.from[0]); wired.add(e.to[0]); }
        for (const n of doc.nodes) assert.ok(wired.has(n.id) || doc.nodes.length === 1, `${n.id} is connected to nothing`);
      });
    });
  }
});
