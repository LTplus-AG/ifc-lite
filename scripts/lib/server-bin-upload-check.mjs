/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Upload-step verification for scripts/check-server-bin-targets.mjs.
 *
 * The "Upload to GitHub Release" step of server-binaries.yml is the one place
 * where the built archives and their SHA-256 sidecars become release assets,
 * and the install-time resolver (packages/server-bin/src/platform.ts) plus
 * the fail-closed checksum verification (packages/server-bin/src/checksum.ts)
 * download those assets by exact name. This module pins that step:
 *
 *   - the asset name must be bound once, to the exact expression the
 *     resolver downloads (UPLOAD_ASSET_EXPR);
 *   - the sidecar name must be bound once, to "$asset.sha256" - the exact
 *     name checksum.ts fetches. Before this binding existed, checksum.ts's
 *     fail-open branch was the ONLY branch that ever executed: the code read
 *     as verified while nothing was;
 *   - every `gh release upload` argument must be one of those two bindings,
 *     and an invocation that ships the archive must ship the sidecar with it,
 *     so no path can ever publish an unverifiable archive again.
 *
 * `uploadStepPublishesSidecars` answers a different question with different
 * strictness: does a given REVISION's workflow publish sidecars at all? It is
 * used on a release tag's own workflow (via git show) to decide whether the
 * release-asset check may demand sidecars, so for it an absent job, step or
 * binding is a definite "no" (historical tags), never an error. That cannot
 * silently weaken the gate for new releases because `checkUploadStep` - which
 * DOES fail closed on all of those - runs against the current tree first on
 * every path that reaches the detector.
 *
 * Inputs are comment-stripped by the caller (see server-bin-targets-parse.mjs
 * for why). Executable proof: scripts/check-server-bin-targets.test.mjs.
 */

import { fail, jobBlock, unquoteScalar } from './server-bin-targets-parse.mjs';

/**
 * The exact expression the upload step must use for the archive filename.
 * The resolver downloads `ifc-lite-server-<target>.<ext>`; pinning the
 * workflow to this literal makes the two names provably identical instead
 * of two hand-maintained strings that agree by luck.
 */
// The ${{ }} is a GitHub Actions expression pinned as a literal, not a JS template.
// eslint-disable-next-line no-template-curly-in-string
export const UPLOAD_ASSET_EXPR = 'ifc-lite-server-${{ matrix.target }}.${{ matrix.archive }}';

/** The exact sidecar name checksum.ts fetches: "<asset>.sha256". */
export const SIDECAR_EXPR = '$asset.sha256';

const UPLOAD_STEP = 'Upload to GitHub Release';
const JOB = 'release-server-binaries';

/** Slice the upload step out of a job block, or null when absent. */
function sliceUploadStep(jobBody) {
  const stepStart = jobBody.indexOf(`- name: ${UPLOAD_STEP}`);
  if (stepStart === -1) return null;
  const rest = jobBody.slice(stepStart + 1);
  const nextStep = /\n {6}- name:/.exec(rest);
  return jobBody.slice(stepStart, nextStep ? stepStart + 1 + nextStep.index : jobBody.length);
}

/** Extract the upload step's block from the (comment-stripped) workflow. */
function uploadStepBlock(workflow, origin) {
  const step = sliceUploadStep(jobBlock(workflow, JOB, origin));
  if (step === null) {
    fail(
      `cannot find the "${UPLOAD_STEP}" step in job "${JOB}" of ${origin}; ` +
      `if the step was renamed, update this check - it must not pass without pinning the upload filenames`,
    );
  }
  return step;
}

/**
 * Require exactly one `<name>=` binding in the step, with the given value.
 * A missing binding, a rebinding (`=` again or `+=`) and a drifted value are
 * each their own failure, because each reopens a distinct hole: no name, a
 * later name the pin never saw, or a wrong name with the pin intact.
 */
function checkBinding(step, origin, name, expectedValue, consumer, verb) {
  const assigns = [...step.matchAll(new RegExp(`^[ \\t]*${name}(\\+?=)(.*)$`, 'gm'))];
  if (assigns.length === 0) {
    fail(
      `the "${UPLOAD_STEP}" step in ${origin} no longer assigns ${name}=...; the step must ` +
      `bind ${name} to "${expectedValue}", the exact name ${consumer} ${verb} - ` +
      `if the script was restructured, update this check`,
    );
  }
  if (assigns.length > 1) {
    fail(
      `the "${UPLOAD_STEP}" step in ${origin} writes the ${name} variable ${assigns.length} ` +
      `times; a rebinding after the pinned assignment could upload a name nothing ever ` +
      `downloads, so exactly one ${name}= line is allowed`,
    );
  }
  const [, op, rawValue] = assigns[0];
  const assigned = unquoteScalar(rawValue.trim());
  if (op !== '=' || assigned !== expectedValue) {
    fail(
      `the "${UPLOAD_STEP}" step in ${origin} assigns ${name}${op}${rawValue.trim()} but ` +
      `${consumer} ${verb} exactly "${expectedValue}"; the two must be identical`,
    );
  }
}

/**
 * Normalise one shell token to compare against the pinned bindings: strip
 * one layer of double quotes (single quotes never expand in bash, so they
 * stay - '$asset' must remain red) and fold ${asset}/${sidecar} braces.
 */
function normaliseArg(token) {
  return token
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^\$\{(asset|sidecar)\}$/, (_, name) => `$${name}`);
}

/**
 * The release upload step must bind the archive name to UPLOAD_ASSET_EXPR and
 * the sidecar name to SIDECAR_EXPR, and every `gh release upload` invocation
 * must pass only those bindings - with the sidecar accompanying the archive
 * wherever the archive is shipped. Mere presence of the literals is not
 * enough: a comment can carry the old name while the assignment or the upload
 * argument drifts, and then every release 404s (archive) or every install
 * fails closed (sidecar) while the gate blesses it.
 */
export function checkUploadStep(workflow, origin, platformTs) {
  const step = uploadStepBlock(workflow, origin);

  checkBinding(step, origin, 'asset', UPLOAD_ASSET_EXPR,
    `the resolver in ${platformTs}`, 'downloads');
  checkBinding(step, origin, 'sidecar', SIDECAR_EXPR,
    'the install-time verification in packages/server-bin/src/checksum.ts', 'fetches');

  const uploads = [...step.matchAll(/gh release upload[ \t]+([^\n]+)/g)];
  let archiveCarrying = 0;
  for (const [, rawArgs] of uploads) {
    // First token is the tag; flags (--clobber) are not asset arguments.
    const args = rawArgs.trim().split(/[ \t]+/).slice(1).filter((t) => !t.startsWith('-'));
    const names = args.map(normaliseArg);
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== '$asset' && names[i] !== '$sidecar') {
        fail(
          `a "gh release upload" invocation in the "${UPLOAD_STEP}" step of ${origin} passes ` +
          `${args[i]} as an asset argument; only the pinned "$asset" and "$sidecar" bindings ` +
          `provably upload the names the resolver in ${platformTs} downloads and checksum.ts verifies`,
        );
      }
    }
    if (names.includes('$asset')) {
      archiveCarrying += 1;
      if (!names.includes('$sidecar')) {
        fail(
          `a "gh release upload" invocation in the "${UPLOAD_STEP}" step of ${origin} uploads the ` +
          `archive without its checksum sidecar; checksum.ts fails closed on a missing sidecar, so ` +
          `every path that ships "$asset" must ship "$sidecar" with it`,
        );
      }
    }
  }
  if (archiveCarrying < 2) {
    fail(
      `expected the release and backfill paths of the "${UPLOAD_STEP}" step in ${origin} ` +
      `to each invoke "gh release upload <tag> ... $asset ..."; found ${archiveCarrying} ` +
      `archive-carrying invocation(s) - if the step was restructured, update this check`,
    );
  }
}

/**
 * Whether a workflow revision publishes checksum sidecars: true exactly when
 * its upload step carries the pinned SIDECAR_EXPR binding. Deliberately
 * lenient where checkUploadStep is strict - see the module header for why an
 * absent job/step/binding is a definite "no" here, not an error.
 */
export function uploadStepPublishesSidecars(workflow) {
  const job = new RegExp(`^  ${JOB}:[ \\t]*$`, 'm').exec(workflow);
  if (!job) return false;
  const bodyStart = job.index + job[0].length;
  const next = /^  [A-Za-z0-9_-]+:/m.exec(workflow.slice(bodyStart));
  const body = next ? workflow.slice(bodyStart, bodyStart + next.index) : workflow.slice(bodyStart);
  const step = sliceUploadStep(body);
  if (step === null) return false;
  const assign = /^[ \t]*sidecar=(.*)$/m.exec(step);
  return assign !== null && unquoteScalar(assign[1].trim()) === SIDECAR_EXPR;
}
