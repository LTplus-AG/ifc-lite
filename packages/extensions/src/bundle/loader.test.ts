/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBundleFromDirectory } from './loader-node.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLES = join(__dirname, '..', '..', 'test', 'fixtures', 'bundles');

describe('loadBundleFromDirectory — happy path', () => {
  it('loads a complete bundle', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'good'));
    if (!r.ok) {
      console.error(r.errors);
    }
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest.id).toBe('com.example.good-bundle');
      expect(r.value.files.has('manifest.json')).toBe(true);
      expect(r.value.files.has('src/activate.js')).toBe(true);
      expect(r.value.files.has('src/commands/run.js')).toBe(true);
      expect(r.value.files.has('widgets/panel.json')).toBe(true);
    }
  });

  it('attaches source info', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'good'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source?.kind).toBe('directory');
    }
  });

  it('decodes text files', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'good'));
    if (!r.ok) throw new Error('expected ok');
    const file = r.value.files.get('src/commands/run.js');
    expect(file?.text).toContain('export default');
  });
});

describe('loadBundleFromDirectory — broken bundles', () => {
  it('rejects missing manifest.json', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'broken', 'no-manifest'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe('manifest.json');
      expect(r.errors[0].code).toBe('required');
    }
  });

  it('rejects malformed JSON', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'broken', 'bad-json'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe('manifest.json');
      expect(r.errors[0].code).toBe('invalid_format');
    }
  });

  it('rejects bundle referencing a missing source file', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'broken', 'missing-entry'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const refError = r.errors.find((e) => e.code === 'invalid_reference');
      expect(refError).toBeDefined();
    }
  });

  it('rejects bundle referencing a missing widget', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'broken', 'missing-widget'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'invalid_reference')).toBe(true);
    }
  });

  it('rejects nonexistent path', async () => {
    const r = await loadBundleFromDirectory(join(BUNDLES, 'does-not-exist'));
    expect(r.ok).toBe(false);
  });
});
