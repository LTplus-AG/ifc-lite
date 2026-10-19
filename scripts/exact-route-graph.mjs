/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// @unwired-by-design Offline draft/review utility; never qualifies a draft itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { digest } from './exact-route-inputs.mjs';
import { sha256 } from './exact-route-source.mjs';
const equal = (a, b, why) => { if (!isDeepStrictEqual(a, b)) throw Error(why); };
const sourcePin = r => ({ compileContextSha256: r.compilerContextSha256, commit: r.source, tree: r.sourceTree,
  inputsSha256: digest(r.trackedSourceHashes), cargoLock: r.trackedSourceHashes['Cargo.lock'],
  manifests: Object.fromEntries(Object.entries(r.trackedSourceHashes).filter(([p]) => p === 'Cargo.toml' || p.endsWith('/Cargo.toml'))) });
export function graphUnits(rows) {
  return rows.map(row => {
    const links = row.linked.map(link => {
      if (link.kind === 'sysroot') return link;
      const owners = rows.filter(u => u.artifacts[link.path] === link.sha256);
      if (owners.length !== 1) throw Error('ambiguous graph linked artifact owner');
      return { name: link.name, unit: owners[0].key };
    });
    const { key, package: name, workspace, sourceDigest, manifestPath, manifestSha256, profile, features, policy } = row;
    return { key, package: name, workspace, sourceDigest, manifestPath, manifestSha256, profile, features, policy, links };
  });
}
export function draftGraph(a, b) {
  // A draft is a literal record, NOT authorization. The parent must review all
  // policies/edges and supply the independent digest of the reviewed file.
  const sides = [a, b].map(r => ({ source: sourcePin(r), units: graphUnits(r.compiler.units) }));
  const keys = sides.map(s => new Set(s.units.map(u => u.key)));
  return { format: 'exact-route-reviewed-graph-v1', sides,
    added: [...keys[1]].filter(k => !keys[0].has(k)), removed: [...keys[0]].filter(k => !keys[1].has(k)),
    workspacePackages: ['ifc-lite-imported-geometry', 'ifc-lite-geometry-runtime'],
    externalTransitions: [], featureDeclarations: [] };
}
function stripped(policy, links, common, declaration) {
  const args = policy.optionsInOrder, out = [];
  const extras = new Set(links.filter(l => !common.some(c => isDeepStrictEqual(l, c))).map(l => l.name));
  let declarations = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extern' && extras.has(args[i + 1]?.split('=')[0])) { i++; continue; }
    if (declaration && args[i] === '--check-cfg' && args[i + 1] === declaration) {
      declarations++; i++; continue;
    }
    out.push(args[i]);
  }
  if (declaration && declarations !== 1) throw Error('feature declaration argument missing/repeated');
  return { version: policy.version, optionsInOrder: out };
}
export function compareReviewedGraph(a, b, expected, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '') || sha256(expected.bytes) !== expectedHash) throw Error('independent reviewed graph digest required');
  const witness = JSON.parse(expected.bytes);
  if (witness.format !== 'exact-route-reviewed-graph-v1' || !Array.isArray(witness.sides) || witness.sides.length !== 2 ||
      !Array.isArray(witness.workspacePackages) || !Array.isArray(witness.externalTransitions) || !Array.isArray(witness.featureDeclarations)) throw Error('invalid reviewed graph witness');
  const observed = draftGraph(a, b);
  equal(witness.sides, observed.sides, 'reviewed source/unit/policy/edge witness mismatch');
  for (const k of ['added', 'removed']) equal(witness[k], observed[k], `reviewed graph ${k} differs`);
  const [left, right] = witness.sides.map(s => new Map(s.units.map(u => [u.key, u])));
  for (const [i, map] of [left, right].entries()) {
    if (map.size !== witness.sides[i].units.length) throw Error('duplicate graph unit');
    const pins = witness.sides[i].source;
    if (!pins.cargoLock || !pins.manifests['Cargo.toml']) throw Error('graph source lacks Cargo manifest/lock pins');
    for (const row of map.values()) if (row.workspace && pins.manifests[row.manifestPath] !== row.manifestSha256) throw Error('workspace unit ownership not manifest-bound');
  }
  const sysroots = witness.sides.map(s => {
    const result = new Map();
    for (const u of s.units) for (const link of u.links.filter(l => l.kind === 'sysroot')) {
      if (result.has(link.name)) equal(result.get(link.name), link.sha256, 'inconsistent toolchain sysroot bytes');
      result.set(link.name, link.sha256);
    }
    return result;
  });
  for (const [name, sha] of sysroots[0]) if (sysroots[1].has(name)) equal(sha, sysroots[1].get(name), 'toolchain sysroot bytes differ');
  const externalUsed = new Set(), declarationsUsed = new Set();
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(key), y = right.get(key), row = x ?? y;
    const external = witness.externalTransitions.includes(key);
    if (!row.workspace && external) externalUsed.add(key);
    if (!x || !y) {
      if (row.workspace ? !witness.workspacePackages.includes(row.package) : !external) throw Error(`unknown graph addition/removal: ${key}`);
      // Full source, manifest hash, features, compiler arguments and edges of
      // every one-sided unit remain literal in the independently pinned sides.
      continue;
    }
    if (x.workspace !== y.workspace || x.manifestPath !== y.manifestPath) throw Error('unit changed source ownership');
    if (!row.workspace && !external) equal(x, y, `external source/policy/edges changed: ${key}`);
    if (!row.workspace && external) continue; // Exact before/after expectation, never a package-wide exemption.
    for (const field of ['profile', 'features']) equal(x[field], y[field], `common workspace ${field} changed: ${key}`);
    if (!isDeepStrictEqual(x.links, y.links) && x.manifestSha256 === y.manifestSha256) throw Error('common workspace edge transition lacks changed owning Cargo manifest');
    const common = x.links.filter(l => y.links.some(r => isDeepStrictEqual(l, r)));
    equal(common, y.links.filter(l => x.links.some(r => isDeepStrictEqual(l, r))), 'common dependency order changed');
    const declaration = witness.featureDeclarations.find(d => d.unit === key);
    if (declaration) {
      if (witness.featureDeclarations.filter(d => d.unit === key).length !== 1 || x.manifestSha256 === y.manifestSha256 ||
          declaration.manifest !== x.manifestPath || ![declaration.before, declaration.after].every(v =>
            typeof v === 'string' && /^cfg\(feature, values\((?:"[A-Za-z0-9_+.-]+"(?:, )?)*\)\)$/.test(v))) throw Error('invalid source-pinned feature declaration transition');
      declarationsUsed.add(key);
    }
    equal(stripped(x.policy, x.links, common, declaration?.before), stripped(y.policy, y.links, common, declaration?.after), `common workspace compiler policy changed: ${key}`);
  }
  if (externalUsed.size !== witness.externalTransitions.length || declarationsUsed.size !== witness.featureDeclarations.length) throw Error('unused/repeated transition authorization');
  return { sha256: expectedHash, added: witness.added, removed: witness.removed,
    sides: witness.sides.map(s => ({ source: s.source, units: s.units.length })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b, out] = process.argv.slice(2);
  if (!a || !b || !out) throw Error('usage: exact-route-graph.mjs BASE_RECEIPT BRANCH_RECEIPT NEW_DRAFT_FILE');
  writeFileSync(out, `${JSON.stringify(draftGraph(JSON.parse(readFileSync(a)), JSON.parse(readFileSync(b))), null, 2)}\n`, { flag: 'wx' });
  console.log('UNREVIEWED graph draft written; independently verify sources, terminal traces, policies and edges before pinning its SHA256.');
}
