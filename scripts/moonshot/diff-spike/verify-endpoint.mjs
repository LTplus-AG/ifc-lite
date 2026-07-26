/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 trajectory verification: the endpoint section, shared verbatim by
 * the v1 and v2 chain verifiers.
 *
 * The endpoint is where the chain stops being self-referential: the final
 * parameters are materialized as a real IFC, the committed canonical hash
 * is re-derived from the rebuild, and the wasm kernel re-measures the
 * quantities the certificate binds. Hash checks alone only prove the
 * numbers are the ones that were bound; the re-measurement is what makes a
 * consistent forgery of the kernel outcome detectable.
 */

import path from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CARBON_FACTORS } from './carbon-model.mjs';
import { buildIfc, REPO_ROOT } from './build-ifc.mjs';
import { kernelVolumes } from './kernel-check.mjs';
import {
  makeStateResolver, endpointKernelPayload, endpointRootPayload, sha256hex,
  canonicalIfc, statePayloads,
} from './trajectory.mjs';
import { fail, computeNodeHash, verifyCertificate } from './verify-common.mjs';

/**
 * Endpoint verification shared by the v1 and v2 paths: `x` is the final
 * design vector the (skeleton or replay) walk arrived at, `cur` its
 * committed state, `k` the final step index. Returns `{ kernelMs }` on
 * success, or a fail()-shaped result (whose `.failure` the caller
 * propagates) on any endpoint check failing.
 */
export async function verifyEndpointSection(chain, x, cur, k, { skipKernel, recheckCli, log }) {
  const scenario = chain.scenario;
  const ep = chain.endpoint;
  if (!ep) return fail('endpoint', 'missing-endpoint');
  // The bound outcome must itself be kernel-acceptable: hash/certificate
  // checks below only prove the numbers are the ones that were bound, not
  // that they describe an ACCEPTED end state. Sentinels (-1 from unparsed
  // CLI output), non-finite depths, validation errors, or real clashes must
  // fail verification here.
  if (!Number.isInteger(ep.validate?.errors) || ep.validate.errors < 0
    || !Number.isInteger(ep.clash?.real) || ep.clash.real < 0
    || !Number.isFinite(ep.clash?.worstDepth)) {
    return fail('endpoint', 'unmeasured-endpoint', { validate: ep.validate, clash: ep.clash });
  }
  if (ep.validate.errors > 0 || ep.clash.real > 0) {
    return fail('endpoint', 'endpoint-not-acceptable', { validateErrors: ep.validate.errors, realClashes: ep.clash.real });
  }
  if (ep.stateIndex !== k || ep.stateRoot !== cur.root) {
    return fail('endpoint', 'endpoint-state-mismatch', { stateIndex: ep.stateIndex, stateRoot: ep.stateRoot, expected: cur.root });
  }
  // Hash commitments over the bound kernel numbers (exact, from recorded
  // values - the values themselves are re-measured below).
  const kernelHash = await computeNodeHash('property-set', endpointKernelPayload(ep));
  if (kernelHash !== ep.kernelHash) {
    return fail('endpoint', 'kernel-pset-hash-mismatch', { recorded: ep.kernelHash, recomputed: kernelHash });
  }
  const endpointRoot = await computeNodeHash('element', endpointRootPayload(cur.root, kernelHash));
  if (endpointRoot !== ep.endpointRoot) {
    return fail('endpoint', 'endpoint-root-mismatch', { recorded: ep.endpointRoot, recomputed: endpointRoot });
  }
  const resolver = makeStateResolver([{ k, committed: cur }]);
  const epResolver = async (nodeId) => {
    if (nodeId === 'endpoint/kernel') {
      return { kind: 'property-set', payload: endpointKernelPayload(ep) };
    }
    if (nodeId === 'endpoint/root') {
      return { kind: 'element', payload: endpointRootPayload(cur.root, kernelHash) };
    }
    return resolver(nodeId);
  };
  const certRes = await verifyCertificate(ep.certificate, epResolver, {
    expectedTrustRoot: chain.trustRoot,
    expectedKernelVersion: chain.kernelVersion,
  });
  if (!certRes.ok) {
    return fail('endpoint', `certificate-invalid:${certRes.reason}`, certRes.details);
  }

  let kernelMs = 0;
  if (!skipKernel) {
    const tk = performance.now();
    // Rebuild the IFC from the final parameters and pin it to the CANONICAL
    // hash (GlobalIds and two header timestamps are run-local randomness a
    // rebuild cannot reproduce; canonicalIfc() strips exactly those - see
    // trajectory.mjs. The raw ifcSha256 is the on-disk artifact label and
    // is not re-derivable, so it is not checked here.)
    const { content, mapping } = buildIfc(x);
    const sha = `sha256:${sha256hex(canonicalIfc(content))}`;
    if (sha !== ep.ifcCanonicalSha256 || content.length !== ep.ifcBytes) {
      return fail('endpoint', 'ifc-rebuild-mismatch', { recorded: { canonicalSha: ep.ifcCanonicalSha256, bytes: ep.ifcBytes }, recomputed: { canonicalSha: sha, bytes: content.length } });
    }
    // Re-run the real kernel and re-measure.
    const { GeometryProcessor } = await import(
      path.join(REPO_ROOT, 'packages/geometry/dist/index.js')
    );
    const processor = new GeometryProcessor();
    await processor.init();
    const rows = await kernelVolumes(processor, content, mapping);
    const paramVols = new Map(
      statePayloads(x, scenario).numeric.model.elements.map((e) => [e.key, e.volume.v ?? e.volume]));
    let kernelCarbon = 0;
    let worstRel = 0;
    let missing = 0;
    const unmatched = [];
    for (const row of rows) {
      if (row.kernelVolume === undefined) { missing += 1; continue; }
      kernelCarbon += row.kernelVolume * CARBON_FACTORS[row.material];
      const pv = paramVols.get(row.key);
      // A kernel row with no parametric counterpart cannot be compared; NaN
      // here would silently vanish from the worstRel max and let an
      // unmatched element pass as agreement.
      if (pv === undefined || !Number.isFinite(pv)) {
        unmatched.push(row.key);
        continue;
      }
      const rel = Math.abs(row.kernelVolume - pv) / Math.max(pv, 1e-12);
      if (rel > worstRel) worstRel = rel;
    }
    // Tolerance rationale: mesh iteration order inside the wasm pipeline is
    // not contractually stable, so float accumulation of per-mesh volumes
    // can differ in the last ulps between runs. 1e-9 relative is ~5 orders
    // looser than ulp noise and ~2 orders tighter than the f32 mesh floor.
    // Unmatched kernel rows mean the parametric and kernel models disagree on
    // which elements exist, which invalidates the comparison itself.
    if (unmatched.length > 0) {
      return fail('endpoint', 'kernel-element-unmatched', { keys: unmatched.slice(0, 10), count: unmatched.length });
    }
    const carbonRel = Math.abs(kernelCarbon - ep.kernel.carbon) / Math.max(ep.kernel.carbon, 1e-12);
    if (carbonRel > 1e-9) {
      return fail('endpoint', 'kernel-carbon-mismatch', { recorded: ep.kernel.carbon, remeasured: kernelCarbon, rel: carbonRel });
    }
    if (Math.abs(worstRel - ep.kernel.worstRelDev) > 1e-9 || missing !== ep.kernel.missingMeshes) {
      return fail('endpoint', 'kernel-deviation-mismatch', { recorded: ep.kernel, remeasured: { worstRel, missing } });
    }
    if (recheckCli) {
      // The chain file's directory may be read-only for the verifier; the
      // rebuilt IFC goes to a temp dir. CLI or parse failures return the
      // machine-readable 'cli-recheck-unavailable' instead of an uncaught
      // rejection tearing down the whole verification.
      try {
        const { runCli, parseCliJson } = await import('./optimize.mjs');
        const tmpIfc = path.join(mkdtempSync(path.join(tmpdir(), 'ifc-lite-verify-')), 'verify-rebuilt.ifc');
        writeFileSync(tmpIfc, content);
        const val = parseCliJson(runCli(['validate', tmpIfc, '--json']).stdout);
        const valErrors = (val.issues ?? []).filter((i) => i.severity === 'error').length;
        if (valErrors !== ep.validate.errors) {
          return fail('endpoint', 'validate-recheck-mismatch', { recorded: ep.validate.errors, remeasured: valErrors });
        }
        const clash = parseCliJson(runCli(['clash', tmpIfc, '--mode', 'hard', '--json']).stdout);
        const real = (clash.clashes ?? []).filter((c) => c.distance < -1e-4).length;
        if (real !== ep.clash.real) {
          return fail('endpoint', 'clash-recheck-mismatch', { recorded: ep.clash.real, remeasured: real });
        }
      } catch (err) {
        return fail('endpoint', 'cli-recheck-unavailable', { message: err.message });
      }
    }
    kernelMs = performance.now() - tk;
    log(`endpoint kernel re-measurement: carbon ${kernelCarbon.toFixed(1)} kgCO2e ` +
      `(rel dev vs bound ${carbonRel.toExponential(2)}), ifc hash pinned, ${(kernelMs / 1000).toFixed(1)}s` +
      (recheckCli ? ', validate+clash rechecked' : ''));
  }

  return { kernelMs };
}
