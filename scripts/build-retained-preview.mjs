#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Assemble the retained-only hosted preview (#7955): a viewer dist built with
// VITE_RETAINED_GEOMETRY=on plus ONE staged engine (stage-cli-retained-engine.mjs)
// laid out at /smlib/ and /retained-engine/, the notices served beside it, and a
// static host config (vercel.json) with cross-origin isolation on every response.
//
//   node scripts/build-retained-preview.mjs --dist /abs/apps/viewer/dist \
//     --engine /abs/staged-engine --out /abs/new-dir (--source-tag v27.1.1 | --rehearsal)
//
// Packaging only: it never builds, deploys or uploads. The output is
// `<out>/vercel.json` + `<out>/public/**` + `<out>/public/retained-preview.json`.
// --source-tag requires every IFC-Lite notice copy to carry that exact covered-source
// URL (fill licenses/retained/THIRD_PARTY_NOTICES.txt before build-wasm and staging).
// --rehearsal accepts the <tag> placeholder for a local run and marks the output
// `publishable: false`; it is not a distribution.
// The production viewer build is untouched: this is a separate output directory.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { SOURCE_URL_NOTICES, missingNotices, noticeSourceProblems, previewHostConfig, servedEngineFiles } from './lib/retained-preview.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The viewer's retained loader URL, present only in a VITE_RETAINED_GEOMETRY=on build. */
const RETAINED_LOADER = '/retained-engine/pkg-retained/ifc-lite.js';

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return walk(root, path);
    if (!entry.isFile()) throw new Error(`Not a regular file: ${join(root, path)}`);
    return [path];
  });
}

/** Verify the engine directory against its manifest; returns the manifest and its sha256. */
export function verifyEngine(engine) {
  const raw = readFileSync(join(engine, 'engine-manifest.json'));
  const manifest = JSON.parse(raw);
  if (manifest.format !== 'ifc-lite.retained-engine/1') throw new Error(`engine manifest format ${manifest.format}`);
  for (const asset of manifest.assets) {
    const file = join(engine, asset.path);
    if (!lstatSync(file).isFile()) throw new Error(`engine asset is not a regular file: ${asset.path}`);
    const bytes = readFileSync(file);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`engine asset changed since staging: ${asset.path}`);
  }
  const listed = new Set(['engine-manifest.json', ...manifest.assets.map(a => a.path)]);
  const extra = walk(engine).filter(path => !listed.has(path.split('\\').join('/')));
  if (extra.length) throw new Error(`files outside the engine manifest: ${extra.slice(0, 5).join(', ')}`);
  return { manifest, manifestSha256: sha256(raw) };
}

/** A dist built without VITE_RETAINED_GEOMETRY=on has no retained loader and would load exact. */
export function assertRetainedDist(dist) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist}: no index.html (build the viewer first)`);
  const chunks = walk(dist).filter(path => path.endsWith('.js'));
  if (!chunks.some(path => readFileSync(join(dist, path), 'utf8').includes(RETAINED_LOADER))) {
    throw new Error(`${dist}: no chunk references ${RETAINED_LOADER}; build with VITE_RETAINED_GEOMETRY=on (outside Vercel)`);
  }
  for (const prefix of ['smlib', 'retained-engine']) {
    if (existsSync(join(dist, prefix))) throw new Error(`${dist}/${prefix} already exists; the dist must not carry engine files`);
  }
}

function gitCommit() {
  const result = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function buildRetainedPreview({ dist, engine, out, sourceTag, rehearsal = false }) {
  for (const [name, value] of Object.entries({ dist, engine, out })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  if (process.env.VERCEL !== undefined) throw new Error('Refusing to assemble a retained preview inside a Vercel build');
  if (Boolean(sourceTag) === Boolean(rehearsal)) throw new Error('Pass exactly one of --source-tag vX.Y.Z or --rehearsal');
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
  for (const input of [dist, engine]) {
    const delta = relative(input, out);
    if (!delta.startsWith('..') && !isAbsolute(delta)) throw new Error('Output must not be inside an input');
  }
  const { manifest, manifestSha256 } = verifyEngine(engine);
  const missing = missingNotices(manifest.assets);
  if (missing.length) throw new Error(`engine lacks notices that must be served with it: ${missing.join(', ')}`);
  const noticeState = {};
  for (const path of SOURCE_URL_NOTICES) {
    const problems = noticeSourceProblems(readFileSync(join(engine, path), 'utf8'), sourceTag);
    if (sourceTag && problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
    noticeState[path] = problems.length ? problems : ['ok'];
  }
  assertRetainedDist(dist);

  const temporary = `${out}.partial-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    const pub = join(temporary, 'public');
    cpSync(dist, pub, { recursive: true, errorOnExist: true, force: false });
    const served = servedEngineFiles(manifest.assets);
    for (const { source, url } of served) {
      const target = join(pub, url.slice(1));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(engine, source), target, { errorOnExist: true, force: false });
    }
    const identity = {
      schema: 'ifc-lite.retained-preview/1',
      publishable: Boolean(sourceTag),
      sourceTag: sourceTag ?? null,
      note: sourceTag ? 'Retained-only preview; production viewer unchanged.'
        : 'REHEARSAL: notices carry the <tag> placeholder. Not for publication.',
      builderCommit: gitCommit(),
      engineManifestSha256: manifestSha256,
      engine: { sdkRevision: manifest.sdk?.revision ?? null, qualified: manifest.qualified, buildAttestation: manifest.buildAttestation },
      notices: noticeState,
      servedEngineFiles: served.length,
    };
    writeFileSync(join(pub, 'retained-preview.json'), `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(temporary, 'vercel.json'), `${JSON.stringify(previewHostConfig(), null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, out);
    return identity;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--rehearsal') { options.rehearsal = true; continue; }
    const name = { '--dist': 'dist', '--engine': 'engine', '--out': 'out', '--source-tag': 'sourceTag' }[key];
    if (!name || argv[i + 1] === undefined) {
      throw new Error('Usage: node scripts/build-retained-preview.mjs --dist ABS --engine ABS --out ABS (--source-tag vX.Y.Z | --rehearsal)');
    }
    options[name] = argv[++i];
  }
  const identity = buildRetainedPreview(options);
  console.log(`Retained preview in ${options.out}: engine ${identity.engineManifestSha256}, ${identity.servedEngineFiles} engine files, publishable=${identity.publishable}`);
}

if (isMainEntry(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
