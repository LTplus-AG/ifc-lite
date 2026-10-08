/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ProfileArtifact { path: string; sha256: string }
export interface NightProfile {
  version: 1;
  sourceHead: string;
  rustTree: string;
  dist: string;
  fixture: string;
  /** Full viewer distribution, runtime, fixture and independent qualification receipt. */
  artifacts: ProfileArtifact[];
  /** Exact host/browser/display policy identity. No threshold is implied. */
  hostProfile: string;
  qualificationReceipt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HASH = /^[a-f0-9]{40}$/;
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function inside(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\')) throw new Error(`invalid profile path: ${path}`);
  const full = realpathSync(resolve(root, path));
  const local = relative(realpathSync(root), full);
  if (!local || local === '..' || local.startsWith('../') || isAbsolute(local)) {
    throw new Error(`profile artifact escapes checkout: ${path}`);
  }
  return full;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('viewer distribution contains a symlink');
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

/** Decode the immutable profile as supplied; do not replace hashes with current files. */
export function decodeNightProfile(input: unknown): NightProfile {
  if (!input || typeof input !== 'object' || Reflect.get(input, 'version') !== 1) throw new Error('invalid night profile version');
  for (const field of ['sourceHead', 'rustTree']) {
    const value: unknown = Reflect.get(input, field);
    if (typeof value !== 'string' || !GIT_HASH.test(value)) throw new Error(`invalid ${field}`);
  }
  for (const field of ['dist', 'fixture', 'hostProfile', 'qualificationReceipt']) {
    const value: unknown = Reflect.get(input, field);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${field}`);
  }
  const artifacts: unknown = Reflect.get(input, 'artifacts');
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('missing pinned artifacts');
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string'
      || typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) throw new Error('invalid pinned artifact');
    if (paths.has(artifact.path)) throw new Error('duplicate pinned artifact');
    paths.add(artifact.path);
  }
  return input as NightProfile;
}

/**
 * Refuse source/build/fixture drift before browser startup. This verifies bytes,
 * not the contents or sufficiency of the separately reviewed native proof.
 * Output/trend directories must live outside the clean durable checkout.
 */
export function verifyNightProfile(checkout: string, profileBytes: Uint8Array): { profile: NightProfile; profileSha256: string } {
  const profile = decodeNightProfile(JSON.parse(Buffer.from(profileBytes).toString('utf8')) as unknown);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', timeout: 10_000 }).trim();
  if (git('rev-parse', 'HEAD') !== profile.sourceHead || git('rev-parse', 'HEAD:rust') !== profile.rustTree) {
    throw new Error('night profile source or Rust tree changed');
  }
  if (git('status', '--porcelain').length !== 0) throw new Error('night profile checkout is dirty');
  const pinned = new Set<string>();
  for (const artifact of profile.artifacts) {
    const full = inside(checkout, artifact.path);
    if (!statSync(full).isFile() || sha256(readFileSync(full)) !== artifact.sha256) {
      throw new Error(`night profile artifact changed: ${artifact.path}`);
    }
    if (pinned.has(full)) throw new Error('multiple profile paths identify one artifact');
    pinned.add(full);
  }
  const dist = inside(checkout, profile.dist);
  if (!statSync(dist).isDirectory()) throw new Error('night profile distribution is not a directory');
  for (const path of files(dist)) if (!pinned.has(path)) throw new Error(`unpinned viewer artifact: ${relative(checkout, path)}`);
  for (const path of [
    `${profile.dist}/index.html`, profile.fixture, profile.qualificationReceipt,
    'packages/wasm/pkg/ifc-lite_bg.wasm', 'packages/wasm/pkg/ifc-lite.js', 'packages/wasm/pkg/ifc-lite.d.ts',
  ]) if (!pinned.has(inside(checkout, path))) throw new Error(`required profile artifact unpinned: ${path}`);
  return { profile, profileSha256: sha256(profileBytes) };
}
