/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer push` — upload a ref's stack (or a single layer) to a
 * layer registry, together with the check-evidence bytes its manifests
 * reference, so reviewers can fetch the report behind every manifest
 * check (08-review.md §8.4).
 *
 * Push is dumb by design (10-registry.md: dumb storage, smart client):
 * POST each layer, PUT each evidence blob, optionally move a ref. The
 * registry's integrity gate re-verifies everything server-side.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import { getProvenance } from '@ifc-lite/ifcx';
import { getFlag, hasFlag, printJson } from '../output.js';
import { loadEvidence, resolveSide, storeFromArgs, type LayerStore } from './layer-store.js';

export interface PushSummary {
  registry: string;
  layers: string[];
  evidenceUploaded: string[];
  evidenceMissing: string[];
  ref?: string;
}

/** Normalize a registry base URL to its `/api/v1` root. */
export function registryApiBase(raw: string): string {
  let base = raw.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
  if (!base.endsWith('/api/v1')) base = `${base}/api/v1`;
  return base;
}

interface RegistryHttp {
  base: string;
  token?: string;
}

async function call(
  http: RegistryHttp,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (http.token) headers.authorization = `Bearer ${http.token}`;
  const res = await fetch(`${http.base}${path}`, { method, headers, body });
  return { status: res.status, body: await res.text() };
}

function errorOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; reason?: string };
    return parsed.error ?? parsed.reason ?? body;
  } catch {
    return body;
  }
}

/** Evidence digests referenced by a layer's manifest checks. */
function evidenceDigests(file: IfcxFile): string[] {
  const manifest = getProvenance(file);
  const digests: string[] = [];
  for (const check of manifest?.checks ?? []) {
    if (check.specDigest) digests.push(check.specDigest);
    if (check.report) digests.push(check.report);
  }
  return digests;
}

export async function pushToRegistry(
  store: LayerStore,
  spec: string,
  http: RegistryHttp,
  setRef: boolean
): Promise<PushSummary> {
  const side = resolveSide(store, spec);
  const summary: PushSummary = {
    registry: http.base,
    layers: [],
    evidenceUploaded: [],
    evidenceMissing: [],
  };

  for (const file of side.layers) {
    const pushed = await call(http, 'POST', '/layers', JSON.stringify(file));
    if (pushed.status !== 201) {
      throw new Error(`registry refused layer ${file.header.id}: ${pushed.status} ${errorOf(pushed.body)}`);
    }
    summary.layers.push(file.header.id);

    for (const digest of evidenceDigests(file)) {
      if (summary.evidenceUploaded.includes(digest) || summary.evidenceMissing.includes(digest)) continue;
      const bytes = loadEvidence(store, digest);
      if (bytes === undefined) {
        // Evidence published before the local evidence store existed (or on
        // another machine): the digest still verifies the manifest, the
        // bytes are just not fetchable from this store.
        summary.evidenceMissing.push(digest);
        continue;
      }
      const put = await call(http, 'PUT', `/reports/${encodeURIComponent(digest)}`, bytes);
      if (put.status !== 201) {
        throw new Error(`registry refused evidence ${digest}: ${put.status} ${errorOf(put.body)}`);
      }
      summary.evidenceUploaded.push(digest);
    }
  }

  if (setRef) {
    if (side.kind !== 'ref') {
      throw new Error(`--set-ref requires pushing a ref, got ${side.label}`);
    }
    const put = await call(
      http,
      'PUT',
      `/refs/${encodeURIComponent(spec)}`,
      JSON.stringify({ layers: summary.layers })
    );
    if (put.status !== 200 && put.status !== 201) {
      const detail = `registry refused ref ${spec}: ${put.status} ${errorOf(put.body)}`;
      if (put.status === 409) {
        throw new PushPolicyError(`${detail} (protected refs move only via merge)`);
      }
      throw new Error(detail);
    }
    summary.ref = spec;
  }
  return summary;
}

/** Mapped to exit 3, matching `layer merge`'s policy-failure exit code. */
export class PushPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushPolicyError';
  }
}

export async function layerPushCommand(args: string[]): Promise<void> {
  const spec = args[0];
  const registry = getFlag(args, '--registry');
  if (!spec || spec.startsWith('-') || !registry) {
    throw new Error(
      'Usage: ifc-lite layer push <ref|layer-id> --registry <url> [--token <bearer>] [--set-ref] [--json]'
    );
  }
  const store = storeFromArgs(args);
  const http: RegistryHttp = { base: registryApiBase(registry) };
  const token = getFlag(args, '--token') ?? process.env.IFC_LITE_REGISTRY_TOKEN;
  if (token) http.token = token;

  let summary: PushSummary;
  try {
    summary = await pushToRegistry(store, spec, http, hasFlag(args, '--set-ref'));
  } catch (err) {
    if (err instanceof PushPolicyError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  if (hasFlag(args, '--json')) {
    printJson(summary);
    return;
  }
  process.stdout.write(`Pushed ${summary.layers.length} layer(s) to ${summary.registry}\n`);
  if (summary.evidenceUploaded.length > 0) {
    process.stdout.write(`Evidence uploaded: ${summary.evidenceUploaded.length}\n`);
  }
  for (const digest of summary.evidenceMissing) {
    process.stderr.write(`warning: evidence ${digest} not in the local store; digest stays verifiable, bytes not fetchable\n`);
  }
  if (summary.ref) process.stdout.write(`Ref ${summary.ref} updated\n`);
}
