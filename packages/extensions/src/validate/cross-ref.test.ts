/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { Bundle, ExtensionManifest } from '../types.js';
import { crossReferenceBundle } from './cross-ref.js';

function makeBundle(filesList: string[], manifest: Partial<ExtensionManifest> = {}): Bundle {
  const files = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  const enc = new TextEncoder();
  for (const p of filesList) {
    files.set(p, { path: p, bytes: enc.encode(''), text: '' });
  }
  const fullManifest: ExtensionManifest = {
    manifestVersion: 1,
    id: 'com.example.cr',
    name: 'CR',
    description: 'x',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=0.0.0' },
    capabilities: [],
    activation: ['onStartup'],
    entry: {},
    ...manifest,
  };
  return { manifest: fullManifest, files, source: { kind: 'memory' } };
}

describe('crossReferenceBundle — entry paths', () => {
  it('flags missing entry.activate', () => {
    const bundle = makeBundle([], { entry: { activate: 'src/activate.js' } });
    const r = crossReferenceBundle(bundle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe('entry.activate');
    }
  });

  it('flags missing entry.commands handlers', () => {
    const bundle = makeBundle([], { entry: { commands: { 'ext.cmd': 'src/cmd.js' } } });
    const r = crossReferenceBundle(bundle);
    expect(r.ok).toBe(false);
  });

  it('passes when all entry paths exist', () => {
    const bundle = makeBundle(['manifest.json', 'src/activate.js'], { entry: { activate: 'src/activate.js' } });
    expect(crossReferenceBundle(bundle).ok).toBe(true);
  });
});

describe('crossReferenceBundle — widgets and contributions', () => {
  it('flags missing dock widget', () => {
    const bundle = makeBundle(['manifest.json'], {
      contributes: { dock: [{ id: 'p', slot: 'dock.right', title: 'P', widget: 'widgets/p.json' }] },
    });
    const r = crossReferenceBundle(bundle);
    expect(r.ok).toBe(false);
  });

  it('passes when widget exists', () => {
    const bundle = makeBundle(['manifest.json', 'widgets/p.json'], {
      contributes: { dock: [{ id: 'p', slot: 'dock.right', title: 'P', widget: 'widgets/p.json' }] },
    });
    expect(crossReferenceBundle(bundle).ok).toBe(true);
  });

  it('flags missing exporter handler', () => {
    const bundle = makeBundle(['manifest.json'], {
      contributes: { exporters: [{ id: 'x', name: 'X', mimeType: 'text/csv', extension: '.csv', handler: 'src/csv.js' }] },
    });
    expect(crossReferenceBundle(bundle).ok).toBe(false);
  });

  it('flags missing IDS validator handler', () => {
    const bundle = makeBundle(['manifest.json'], {
      contributes: { idsValidators: [{ id: 'i', name: 'I', handler: 'src/ids.js' }] },
    });
    expect(crossReferenceBundle(bundle).ok).toBe(false);
  });

  it('flags missing lens evaluator', () => {
    const bundle = makeBundle(['manifest.json'], {
      contributes: { lenses: [{ id: 'l', name: 'L', evaluator: 'src/lens.js' }] },
    });
    expect(crossReferenceBundle(bundle).ok).toBe(false);
  });
});

describe('crossReferenceBundle — fixtures', () => {
  it('flags unknown fixture ids when catalogue is supplied', () => {
    const bundle = makeBundle(['manifest.json'], {
      tests: [{ name: 't', command: 'ext.c', fixture: 'missing-fixture', expect: { mimeType: 'text/csv' } }],
    });
    const r = crossReferenceBundle(bundle, { knownFixtures: new Set(['small']) });
    expect(r.ok).toBe(false);
  });

  it('passes when fixture is in the catalogue', () => {
    const bundle = makeBundle(['manifest.json'], {
      tests: [{ name: 't', command: 'ext.c', fixture: 'small', expect: { mimeType: 'text/csv' } }],
    });
    const r = crossReferenceBundle(bundle, { knownFixtures: new Set(['small']) });
    expect(r.ok).toBe(true);
  });

  it('skips the fixture check when no catalogue is supplied', () => {
    const bundle = makeBundle(['manifest.json'], {
      tests: [{ name: 't', command: 'ext.c', fixture: 'whatever', expect: { mimeType: 'text/csv' } }],
    });
    expect(crossReferenceBundle(bundle).ok).toBe(true);
  });
});
