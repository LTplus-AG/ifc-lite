/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateManifest } from './validate.js';
import { CURRENT_MANIFEST_VERSION, migrateManifest } from '../migrations/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '..', 'test', 'fixtures', 'manifests');
const VALID_DIR = join(FIXTURE_ROOT, 'valid');
const INVALID_DIR = join(FIXTURE_ROOT, 'invalid');

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('validateManifest — valid fixtures', () => {
  const files = readdirSync(VALID_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    it(`accepts ${file}`, () => {
      const result = validateManifest(loadJson(join(VALID_DIR, file)));
      if (!result.ok) {
        console.error(`Unexpected errors for ${file}:`, result.errors);
      }
      expect(result.ok).toBe(true);
    });
  }
});

describe('validateManifest — invalid fixtures', () => {
  const files = readdirSync(INVALID_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    it(`rejects ${file}`, () => {
      const result = validateManifest(loadJson(join(INVALID_DIR, file)));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        for (const err of result.errors) {
          expect(err.code).toBeTruthy();
          expect(err.message).toBeTruthy();
        }
      }
    });
  }
});

describe('validateManifest — direct inputs', () => {
  it('rejects non-object input', () => {
    expect(validateManifest('foo').ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it('reports missing top-level fields', () => {
    const r = validateManifest({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('required');
    }
  });

  it('accepts a manifest with extra unknown fields but flags them', () => {
    const r = validateManifest({
      manifestVersion: 1,
      id: 'com.example.ok',
      name: 'OK',
      description: '...',
      version: '1.0.0',
      engines: { ifcLiteSdk: '>=2.0.0' },
      capabilities: ['model.read'],
      activation: ['onStartup'],
      entry: {},
      mystery: 'oops',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'unknown_field')).toBe(true);
    }
  });

  it('flags dangling command refs only after structural pass', () => {
    const r = validateManifest({
      manifestVersion: 1,
      id: 'com.example.ref',
      name: 'Ref',
      description: '...',
      version: '1.0.0',
      engines: { ifcLiteSdk: '>=2.0.0' },
      capabilities: ['model.read'],
      activation: ['onStartup'],
      contributes: {
        toolbar: [{ command: 'ext.never.declared', slot: 'toolbar.right' }],
      },
      entry: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'invalid_reference')).toBe(true);
    }
  });

  it('error paths point at offending field', () => {
    const r = validateManifest({
      manifestVersion: 1,
      id: 'com.example.x',
      name: 'X',
      description: '...',
      version: '1.0.0',
      engines: { ifcLiteSdk: '>=2.0.0' },
      capabilities: ['model.read', 'foo.bar'],
      activation: ['onStartup'],
      entry: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path);
      expect(paths.some((p) => p.startsWith('capabilities['))).toBe(true);
    }
  });
});

describe('migrateManifest', () => {
  it('returns v1 unchanged', () => {
    const input = loadJson(join(VALID_DIR, 'minimal.json')) as Record<string, unknown>;
    const r = migrateManifest(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifestVersion).toBe(CURRENT_MANIFEST_VERSION);
    }
  });

  it('rejects newer manifest versions', () => {
    const r = migrateManifest({ manifestVersion: 99 });
    expect(r.ok).toBe(false);
  });

  it('rejects non-numeric manifestVersion', () => {
    const r = migrateManifest({ manifestVersion: 'one' });
    expect(r.ok).toBe(false);
  });
});
