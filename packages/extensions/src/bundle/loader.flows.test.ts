/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `contributes.flows[].path` cross-reference (#5167 phase 4.2): a flow
 * graph contribution names a bundle-relative file, and the same guard
 * that catches a missing exporter handler or widget must catch a missing
 * flow graph file — before it ever reaches the host.
 */

import { describe, expect, it } from 'vitest';
import type { BundleFile } from '../types.js';
import { buildBundleFromFiles } from './loader.js';

function file(path: string, text: string): BundleFile {
  return { path, bytes: new TextEncoder().encode(text), text };
}

function manifestWithFlows(flows: unknown): string {
  return JSON.stringify({
    manifestVersion: 1,
    id: 'com.example.flows',
    name: 'Flow Bundle',
    description: 'Ships a flow graph.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=2.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    contributes: { flows },
    entry: {},
  });
}

describe('buildBundleFromFiles — contributes.flows cross-reference', () => {
  it('accepts a graph whose path exists in the bundle', () => {
    const flows = [{ id: 'g1', name: 'Graph One', path: 'flows/g1.flow.json' }];
    const manifestFile = file('manifest.json', manifestWithFlows(flows));
    const graphFile = file('flows/g1.flow.json', '{"flowVersion":1}');
    const files = new Map([
      ['manifest.json', manifestFile],
      ['flows/g1.flow.json', graphFile],
    ]);
    const r = buildBundleFromFiles(files, manifestFile, { kind: 'memory' });
    expect(r.ok).toBe(true);
  });

  it('rejects a graph whose path is missing from the bundle', () => {
    const flows = [{ id: 'g1', name: 'Graph One', path: 'flows/missing.flow.json' }];
    const manifestFile = file('manifest.json', manifestWithFlows(flows));
    const files = new Map([['manifest.json', manifestFile]]);
    const r = buildBundleFromFiles(files, manifestFile, { kind: 'memory' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].code).toBe('invalid_reference');
    expect(r.errors[0].path).toBe('contributes.flows[].path');
  });
});
