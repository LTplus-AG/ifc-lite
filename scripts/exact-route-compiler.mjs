/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { unitEvidence } from './exact-route-units.mjs';
export function compilerEnvironment(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(v => typeof v !== 'string')) throw Error('invalid compiler environment evidence');
  for (const key of Object.keys(env)) {
    if (key.startsWith('CARGO_PROFILE_')) throw Error(`profile override refused: ${key}`);
    if (key.startsWith('IFC_LITE_')) throw Error(`geometry override refused: ${key}`);
  }
  for (const key of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
    if (env[key]) throw Error(`unverifiable additional compiler wrapper refused: ${key}`);
  }
  const names = ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTUP_TOOLCHAIN', 'CARGO_BUILD_TARGET',
    'CARGO_TARGET_DIR', 'RAYON_NUM_THREADS', 'RUSTC', 'RUSTDOCFLAGS', 'CARGO_BUILD_RUSTFLAGS'];
  return Object.fromEntries(Object.entries(env).filter(([k]) => names.includes(k) ||
    /^CARGO_TARGET_.*_(RUSTFLAGS|LINKER|RUNNER)$/.test(k)));
}
export function compilerEvidence(events, artifacts, context, files) {
  if (!Array.isArray(events) || !events.length || events.some(e => typeof e.compiler !== 'string' || typeof e.version !== 'string' || !e.version ||
      !Array.isArray(e.args) || e.args.some(a => typeof a !== 'string'))) throw Error('missing/malformed compiler arguments');
  const units = unitEvidence(events, artifacts, context, files);
  const example = artifacts.findLast(a => a.reason === 'compiler-artifact' && a.target?.name === 'exact_route_capture' && a.executable);
  const exampleUnits = units.filter(u => u.key.includes('/exact_route_capture/'));
  if (!example || !exampleUnits.length || example.profile.debug_assertions !== false || example.profile.test !== false) throw Error('missing ordinary-profile example');
  for (const event of events.filter(e => e.args.some((a, i) => a === '--crate-name' && e.args[i + 1] === 'exact_route_capture'))) {
    if (!event.args.some(a => a.includes('opt-level=')) || event.args.some(a => /panic=(abort|immediate-abort)/.test(a))) throw Error('unexpected effective capture compiler policy');
  }
  return { events, exampleProfile: example.profile, exampleFeatures: example.features, policies: exampleUnits.map(u => u.policy), units };
}
