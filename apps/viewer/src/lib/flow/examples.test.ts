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
 * The files are also read from disk, so the barrel can be checked against
 * the folder it is supposed to expose: `flowExamples()` is called for real
 * (the test loader implements Vite's `?raw`), and what it returns has to be
 * the documents that are actually there, in the order their numeric
 * prefixes imply — a file added to the folder but not imported would
 * otherwise be invisible in the panel and fail nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAvailability, parseFlowDocument, topologicalOrder, validateFlowWiring, type FlowDocument } from '@ifc-lite/flow';
import { hasCapability, parseCapabilities, parseCapability } from '@ifc-lite/extensions';
import { BROWSER_FEATURES, createStandardRegistry } from '@ifc-lite/flow-nodes';
import { flowExamples } from './examples.js';

const registry = createStandardRegistry();
const dir = join(dirname(fileURLToPath(import.meta.url)), 'examples');
const files = readdirSync(dir).filter((f) => f.endsWith('.flow.json')).sort();
const examples: Array<{ file: string; doc: FlowDocument }> = files.map((file) => ({ file, doc: parseFlowDocument(readFileSync(join(dir, file), 'utf-8')) }));

describe('flow examples', () => {
  it('flowExamples() is the folder, in ladder order', () => {
    // What the panel lists comes from the barrel's imports, not from the
    // folder, so a file added to one and not the other is invisible in the
    // UI and fails nothing else. Comparing ids (not filenames) keeps this
    // honest about what the menu actually offers.
    assert.deepEqual(flowExamples().map((d) => d.id), examples.map((e) => e.doc.id));
    assert.equal(flowExamples().length, files.length);
  });

  it('flowExamples() parses once and hands back the same documents', () => {
    assert.equal(flowExamples(), flowExamples(), 'the panel re-renders; re-parsing eight documents per render is not free');
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
