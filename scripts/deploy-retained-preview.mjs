#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Upload a build-retained-preview.mjs output as a Vercel PREVIEW deployment (#7955).
// Never production: the request carries no `target`, so Vercel makes a preview with
// its own immutable *.vercel.app URL; no alias or domain is assigned and no project
// setting is sent (the uploaded vercel.json applies to this deployment only).
//
//   VERCEL_TOKEN=... node scripts/deploy-retained-preview.mjs --dir /abs/preview \
//     --source-tag v27.1.1 [--project ifc-lite] [--team team_...] [--dry-run]
//
// Publishing the preview distributes SMLib WASM: run it only after the release is
// out and the licensing review record is signed (docs/architecture/retained-licensing.md).
// The token is read from VERCEL_TOKEN and never printed. --dry-run lists what would
// be uploaded and needs no token.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';

const API = 'https://api.vercel.com';
const DEFAULT_TEAM = 'team_xdwayIMVKBKZcFLC0NiQTXIA'; // LTplus, as in deploy-nightly.yml
const DEFAULT_PROJECT = 'ifc-lite';

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(root, path);
    if (!entry.isFile()) throw new Error(`Not a regular file: ${path}`);
    return [path];
  });
}

/** Files to upload with their sha1/size; refuses anything but a publishable preview for the tag. */
export function plan(dir, sourceTag) {
  const identity = JSON.parse(readFileSync(join(dir, 'public/retained-preview.json'), 'utf8'));
  if (identity.schema !== 'ifc-lite.retained-preview/1') throw new Error(`not a retained preview: ${identity.schema}`);
  if (identity.publishable !== true) throw new Error('rehearsal build (publishable=false): notices carry the <tag> placeholder');
  if (identity.sourceTag !== sourceTag) throw new Error(`built for ${identity.sourceTag}, not ${sourceTag}`);
  const files = walk(dir).sort().map(file => {
    if (file !== 'vercel.json' && !file.startsWith('public/')) throw new Error(`unexpected file outside public/: ${file}`);
    const bytes = readFileSync(join(dir, file));
    return { file, sha: createHash('sha1').update(bytes).digest('hex'), size: bytes.length };
  });
  if (!files.some(f => f.file === 'vercel.json')) throw new Error('no vercel.json');
  return { identity, files };
}

async function api(token, method, path, { body, headers = {} } = {}) {
  const options = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (body !== undefined) options.body = body;
  const response = await fetch(`${API}${path}`, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

export async function deploy({ dir, sourceTag, project = DEFAULT_PROJECT, team = DEFAULT_TEAM, dryRun = false, token = process.env.VERCEL_TOKEN }) {
  if (!dir || !isAbsolute(dir)) throw new Error('--dir must be an absolute path');
  if (!sourceTag) throw new Error('--source-tag vX.Y.Z is required');
  const { identity, files } = plan(dir, sourceTag);
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB, engine ${identity.engineManifestSha256}, project ${project}, target preview`);
  if (dryRun) return { dryRun: true, files: files.length, bytes };
  if (!token) throw new Error('VERCEL_TOKEN is not set');
  const queue = [...files];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      await api(token, 'POST', `/v2/files?teamId=${team}`, { body: readFileSync(join(dir, f.file)),
        headers: { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': f.sha, 'Content-Length': String(f.size) } });
    }
  }));
  const created = await api(token, 'POST', `/v13/deployments?teamId=${team}&skipAutoDetectionConfirmation=1`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: project, project, files,
      meta: { retainedPreview: '1', sourceTag, engineManifestSha256: identity.engineManifestSha256 } }),
  });
  if (created.target === 'production') throw new Error(`Vercel reports a production target for ${created.id}; investigate before use`);
  const deadline = Date.now() + 15 * 60_000;
  let state = created.readyState;
  while (!['READY', 'ERROR', 'CANCELED'].includes(state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    state = (await api(token, 'GET', `/v13/deployments/${created.id}?teamId=${team}`)).readyState;
  }
  if (state !== 'READY') throw new Error(`deployment ${created.id} ended ${state}`);
  return { id: created.id, url: `https://${created.url}`, target: created.target ?? 'preview' };
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  deploy({ dir: get('--dir'), sourceTag: get('--source-tag'), project: get('--project'), team: get('--team'), dryRun: args.includes('--dry-run') })
    .then(result => {
      if (result.url) {
        console.log(`preview ${result.url} (${result.id}, ${result.target})`);
        console.log(`next: node scripts/smoke-retained-preview.mjs --url ${result.url} --source-tag ${get('--source-tag')}`);
      }
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
