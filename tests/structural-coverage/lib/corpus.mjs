/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural fixture corpus: the manifest-backed files listed in
 * `tests/structural-coverage/corpus.json`, verified against
 * `tests/models/manifest.json` (size and SHA-256) before any probe reads them.
 *
 * A missing or mismatched file is never skipped quietly. `loadCorpus` throws
 * with the `pnpm fixtures` command that fetches it, unless the caller passed
 * `offline: true`; then the file is listed in `absent`, and every probe that
 * might have needed it reports `skip` (which never counts as a pass).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStep } from './step.mjs';

/** `FILE_SCHEMA` identifier to catalogue schema; anything else has no section here (e.g. IFC4X2). */
export function catalogueSchema(fileSchema) {
  const s = String(fileSchema ?? '').toUpperCase();
  if (s === 'IFC2X3') return 'IFC2X3';
  if (s === 'IFC4') return 'IFC4';
  if (s.startsWith('IFC4X3')) return 'IFC4X3';
  return null;
}

export function loadCorpus(root, { offline = false } = {}) {
  const list = JSON.parse(readFileSync(join(root, 'tests/structural-coverage/corpus.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'tests/models/manifest.json'), 'utf8'));
  const entries = new Map(manifest.files.map((f) => [f.path, f]));
  if (!Array.isArray(list.files) || list.files.length === 0) throw new Error('corpus: corpus.json lists no files');
  const files = [];
  const absent = [];
  for (const path of [...list.files].sort()) {
    const entry = entries.get(path);
    if (!entry) throw new Error(`corpus: ${path} is not registered in tests/models/manifest.json`);
    const abs = join(root, 'tests/models', path);
    const bytes = existsSync(abs) ? readFileSync(abs) : null;
    const sha = bytes && createHash('sha256').update(bytes).digest('hex');
    if (sha !== entry.sha256) {
      absent.push({ path, reason: bytes ? 'sha256 differs from the manifest' : 'missing' });
      continue;
    }
    const text = bytes.toString('latin1');
    const step = readStep(text);
    const schema = catalogueSchema(step.schema);
    files.push({ path, bytes, step, fileSchema: step.schema, schema, sha256: sha });
  }
  if (absent.length && !offline) {
    const paths = absent.map((a) => a.path);
    throw new Error(
      `corpus: ${absent.length} fixture(s) absent or stale: ${absent.map((a) => `${a.path} (${a.reason})`).join(', ')}.\n`
        + `  fetch: node scripts/fixtures/fetch-fixtures.mjs ${paths.join(' ')}\n`
        + '  or run with --offline: those files then score as skip, which never counts as a pass.',
    );
  }
  /** Status when nothing present has what a probe needs: skip while a file is absent, else fail. */
  const nothingFound = (what) => (absent.length
    ? { status: 'skip', reason: `offline: no present corpus file ${what}, and ${absent.length} corpus file(s) are absent` }
    : { status: 'fail', reason: `no corpus file ${what}` });
  return {
    files,
    absent,
    nothingFound,
    /** Files of `schema` that carry at least one record of `entity`. */
    carriers(schema, entity) {
      return files.filter((f) => f.schema === schema && f.step.count(entity) > 0);
    },
    nothingCarries: (schema, entity) => nothingFound(`of ${schema} carries ${entity}`),
  };
}
