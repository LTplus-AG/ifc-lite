/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifySysrootExtern } from './exact-route-externs.mjs';
import { digest } from './exact-route-inputs.mjs';
export const CRITICAL = ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-processing'];
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const equal = (a, b, why) => { if (!isDeepStrictEqual(a, b)) throw Error(why); };
const option = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
export function effectivePolicy(event, sourcePath) {
  const result = [];
  for (let i = 0; i < event.args.length; i++) {
    const arg = event.args[i];
    if (arg === '--out-dir') {
      if (typeof event.args[++i] !== 'string') throw Error('incomplete output directory');
      result.push(arg, '<OUTPUT_DIRECTORY>');
    } else if (arg === '--extern') {
      const value = event.args[++i], split = value?.indexOf('=');
      if (!(split > 0)) {
        if (value !== 'proc_macro') throw Error('incomplete compiler extern');
        result.push(arg, 'proc_macro'); continue;
      }
      result.push(arg, `${value.slice(0, split)}=<BOUND_ARTIFACT>`);
    } else if (arg === '-L' && event.args[i + 1]?.startsWith('dependency=')) {
      i++; result.push(arg, 'dependency=<BOUND_DEPENDENCY_DIRECTORY>');
    } else if (arg.startsWith('-Ldependency=')) result.push('-Ldependency=<BOUND_DEPENDENCY_DIRECTORY>');
    else if (arg === '-C' || arg.startsWith('-C')) {
      const value = arg === '-C' ? event.args[++i] : arg.slice(2);
      if (typeof value !== 'string') throw Error('incomplete compiler codegen option');
      if (/^(metadata|extra-filename)=/.test(value)) continue;
      result.push('-C', value.startsWith('incremental=') ? 'incremental=<DIRECTORY>' : value);
    } else if (arg.endsWith('.rs') && resolve(event.cwd, arg) === resolve(sourcePath)) result.push('<SOURCE>');
    else result.push(arg); // Every other argument remains policy-relevant, in order.
  }
  return { version: event.version, optionsInOrder: result };
}
function validateProfile(unit) {
  const p = unit.profile;
  if (!p || typeof p.opt_level !== 'string' || !/^[0123sz]$/.test(p.opt_level) ||
      !Object.hasOwn(p, 'debuginfo') || !(p.debuginfo === null ||
        [0, 1, 2, 'none', 'limited', 'full', 'line-tables-only', 'line-directives-only'].includes(p.debuginfo)) ||
      ['debug_assertions', 'overflow_checks', 'test'].some(k => typeof p[k] !== 'boolean') ||
      !Array.isArray(unit.features) || unit.features.some(v => typeof v !== 'string') ||
      !unit.target || typeof unit.target.name !== 'string' || !Array.isArray(unit.target.kind) ||
      !unit.target.kind.length || unit.target.kind.some(k => typeof k !== 'string') ||
      typeof unit.target.src_path !== 'string' || typeof unit.package_id !== 'string') throw Error('incomplete dependency profile/identity');
}
function traceMatches(event, unit) {
  if (!event.package || `${event.package.name}@${event.package.version}` !== unit.package_id.split('#').at(-1)) return false;
  const source = unit.target.src_path;
  const out = option(event.args, '--out-dir');
  return out && event.args.some(a => a.endsWith('.rs') && resolve(event.cwd, a) === resolve(source)) &&
    unit.filenames.every(path => dirname(path) === resolve(event.cwd, out));
}
function packageSource(event, context) {
  const pkg = event.package;
  if (!pkg || typeof pkg.name !== 'string' || !pkg.name || typeof pkg.version !== 'string' || !pkg.version || !isAbsolute(pkg.root)) throw Error('missing compiler package identity');
  if (!event.inputsBefore || !Object.keys(event.inputsBefore).length ||
      !Object.hasOwn(event.inputsBefore, 'Cargo.toml') || Object.values(event.inputsBefore).some(v => !hash(v))) throw Error('missing package source fingerprints');
  equal(event.inputsBefore, event.inputsAfter, 'package input bytes changed during compilation');
  const path = relative(context.workspaceRoot, pkg.root), workspace = !path.startsWith('..') && !isAbsolute(path);
  if (workspace) for (const [file, sha] of Object.entries(event.inputsBefore)) {
    const tracked = [path, file].filter(Boolean).join('/');
    if (context.source.trackedSourceHashes[tracked] !== sha) throw Error(`workspace dependency input not Git-bound: ${tracked}`);
  }
  if (!Object.hasOwn(event, 'generatedRoot') || !Object.hasOwn(event, 'generatedInputsBefore') ||
      !Object.hasOwn(event, 'generatedInputsAfter')) throw Error('missing generated compiler input provenance');
  equal(event.generatedInputsBefore, event.generatedInputsAfter, 'generated compiler inputs changed');
  if (event.generatedRoot === null) {
    if (event.generatedInputsBefore !== null) throw Error('unbound generated compiler inputs');
  } else if (!isAbsolute(event.generatedRoot) || !event.generatedInputsBefore || Array.isArray(event.generatedInputsBefore) ||
      Object.values(event.generatedInputsBefore).some(v => !hash(v))) throw Error('malformed generated compiler inputs');
  return { workspace, sourceDigest: digest({ package: event.inputsBefore, generated: event.generatedInputsBefore }) };
}
export function unitEvidence(events, artifacts, context, files) {
  if (!context || context.format !== 'exact-route-compile-context-v1' || !isAbsolute(context.workspaceRoot) ||
      !context.source?.trackedSourceHashes || !context.configuration || typeof context.toolchain !== 'string') throw Error('missing compile context');
  if (!files || Object.values(files).some(v => !hash(v))) throw Error('missing actual artifact byte fingerprints');
  const units = artifacts.filter(a => a.reason === 'compiler-artifact');
  if (!units.length) throw Error('empty compilation unit cohort');
  const result = [], used = new Set();
  for (const unit of units) {
    validateProfile(unit);
    // No retained compile-trace import is implemented. Managed-cache hits remain
    // unqualified; NEVER reinterpret `fresh` as policy evidence or erase caches.
    if (unit.fresh !== false) throw Error(`cached artifact has no qualified retained compile trace: ${unit.package_id}/${unit.target.name}`);
    if (!Array.isArray(unit.filenames) || !unit.filenames.length || unit.filenames.some(p => !isAbsolute(p) || !hash(files[p]))) throw Error('unbound Cargo artifact bytes');
    const matches = events.map((event, index) => ({ event, index })).filter(({ event }) => traceMatches(event, unit));
    if (matches.length !== 1) throw Error(`missing/ambiguous reached dependency compiler trace: ${unit.target.name}`);
    const { event, index } = matches[0];
    if (used.has(index)) throw Error('one compiler trace reused for multiple units'); used.add(index);
    if (event.args.some(arg => arg.startsWith('@'))) throw Error('unbound compiler response file');
    if (event.status !== 0 || event.signal !== null || event.contextSha256 !== digest(context) || event.version !== context.toolchain ||
        event.cwd !== context.workspaceRoot) throw Error('dependency compiler source/config/toolchain context mismatch');
    equal(event.configurationBefore, context.configuration, 'dependency config differs from admitted context');
    equal(event.configurationAfter, context.configuration, 'dependency config changed during compilation');
    const source = packageSource(event, context);
    const inputPath = relative(event.package.root, unit.target.src_path);
    if (inputPath.startsWith('..') || isAbsolute(inputPath) || !hash(event.inputsBefore[inputPath])) throw Error('compiler source not in bound package snapshot');
    if (!event.outputs || !Object.keys(event.outputs).length || Object.values(event.outputs).some(v => !hash(v))) throw Error('missing terminal compiler output fingerprints');
    for (const path of unit.filenames) {
      // Cargo renames build-script executables after rustc completes. Their
      // copied bytes must still equal the terminal compiler output's bytes.
      const compiled = event.outputs[path] ?? (unit.target.kind.includes('custom-build') || unit.executable === path ?
        Object.values(event.outputs).find(sha => sha === files[path]) : undefined);
      if (compiled !== files[path]) throw Error(`compiler trace/artifact bytes mismatch: ${path}`);
    }
    equal(event.externInputs, event.externAfter, 'linked dependency bytes changed during compilation');
    const linked = [];
    for (let i = 0; i < event.args.length; i++) if (event.args[i] === '--extern') {
      const value = event.args[++i], split = value?.indexOf('=');
      if (!(split > 0)) { linked.push(verifySysrootExtern(event, value)); continue; }
      const path = resolve(event.cwd, value.slice(split + 1));
      if (!hash(files[path]) || event.externInputs?.[path] !== files[path]) throw Error(`linked dependency bytes not traced: ${path}`);
      linked.push({ name: value.slice(0, split), path, sha256: files[path] });
    }
    const key = `${source.workspace ? 'workspace' : unit.package_id}/${event.package.name}@${event.package.version}/${unit.target.name}/${unit.target.kind.join(',')}`;
    if (result.some(row => row.key === key)) throw Error(`duplicate compilation unit identity: ${key}`);
    result.push({ key, package: event.package.name, workspace: source.workspace, sourceDigest: source.sourceDigest,
      manifestPath: source.workspace ? [relative(context.workspaceRoot, event.package.root), 'Cargo.toml'].filter(Boolean).join('/') : null,
      manifestSha256: event.inputsBefore['Cargo.toml'], profile: unit.profile, features: unit.features, policy: effectivePolicy(event, unit.target.src_path), linked,
      artifacts: Object.fromEntries(unit.filenames.map(p => [p, files[p]])), traceIndex: index });
  }
  for (const name of CRITICAL) if (!result.some(row => row.workspace && row.package === name)) throw Error(`missing critical workspace dependency: ${name}`);
  return result;
}
export function compareUnitPolicies(a, b) {
  const byKey = rows => new Map(rows.map(row => [row.key, row]));
  const left = byKey(a), right = byKey(b);
  if (left.size !== a.length || right.size !== b.length || left.size !== right.size) throw Error('dependency unit cohort differs or repeats');
  for (const [key, row] of left) {
    const other = right.get(key); if (!other) throw Error(`unpaired dependency unit policy: ${key}`);
    for (const field of ['profile', 'features', 'policy']) equal(row[field], other[field], `dependency effective ${field} mismatch: ${key}`);
    if (!row.workspace) equal(row.sourceDigest, other.sourceDigest, `external dependency source differs: ${key}`);
    // Artifact bytes can legitimately change with workspace source, but every
    // reached link must refer to another independently qualified unit's bytes.
    const owners = (rows, links) => links.map(link => {
      if (link.kind === 'sysroot') return link;
      const owner = rows.filter(unit => unit.artifacts[link.path] === link.sha256);
      if (owner.length !== 1) throw Error('ambiguous linked artifact owner');
      return { name: link.name, unit: owner[0].key };
    });
    equal(owners(a, row.linked), owners(b, other.linked), `dependency link policy differs: ${key}`);
  }
}
