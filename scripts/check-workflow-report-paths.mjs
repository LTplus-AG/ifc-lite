/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

function filesBelow(root, accept) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path, accept));
    else if (accept(path)) found.push(path);
  }
  return found;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stepsOf = (job) => isRecord(job) && Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
const namedStep = (job, name) => stepsOf(job).find((step) => step.name === name);
const expression = (value) => typeof value === 'string' ? value : '';
const needs = (job, id) => {
  if (!isRecord(job)) return false;
  return job.needs === id || (Array.isArray(job.needs) && job.needs.includes(id));
};

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Split on `operator` where it sits at paren depth 0 and outside a quoted
 *  string. Splitting by regex instead would cut docker.yml's `||` out of its own
 *  parenthesised condition, and would cut a quoted `'||'` operand in half. */
function splitTopLevel(body, operator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (depth === 0 && body.startsWith(operator, i)) {
      parts.push(body.slice(start, i));
      i += operator.length - 1;
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** A branch is a value position, so it must be a bare positive integer. Wrapping
 *  parens are stripped first -- `(180)` is the same value as `180` -- which is
 *  safe to do bluntly because what survives still has to match POSITIVE_INTEGER,
 *  so `f(1)` or `(x && 180 || 120)` fall through to a rejection anyway. */
const positiveIntegerBranch = (token) => POSITIVE_INTEGER.test(token.replace(/^[\s(]+|[\s)]+$/g, ''));

/**
 * `timeout-minutes` may be a GitHub expression rather than a literal: docker.yml
 * picks 180 for a release build and 120 otherwise (#4809). The audit cannot
 * evaluate an expression, so it accepts one only in the two shapes where EVERY
 * value the expression can produce is visible without evaluating anything:
 *
 *   ${{ 120 }}                          a literal wearing an expression
 *   ${{ <condition> && 180 || 120 }}    GitHub's ternary idiom
 *
 * `&&` and `||` in GitHub expressions return an OPERAND, not a boolean, so the
 * value is always one of the operands. In `C1 && .. && Cn || F` exactly two of
 * them can survive: the `&&` chain yields Cn when every conjunct is truthy, and
 * otherwise yields its first falsy conjunct, which `|| F` then replaces. So Cn
 * and F are the value positions and both must be a bare positive integer, while
 * C1..Cn-1 are never read -- that is what keeps a comparison against a numeral
 * (`inputs.tag == 'v1.0' && 180 || 120`) from being mistaken for a timeout of 0.
 *
 * A CHAIN (`a && 60 || b && 120 || 180`) is rejected even though every branch in
 * it happens to be positive. Reading it correctly means evaluating precedence,
 * and a rule that checks only the first and last branch would let the middle one
 * through: `a && -30 || b && 120 || 180` yields -30 when `a` holds, because -30
 * is truthy. Nothing in this repo writes a chain.
 *
 * Everything else is rejected, including an expression that merely CONTAINS a
 * positive number (`${{ x && 180 || vars.FALLBACK }}`). From here, unbounded and
 * "bounded by a value this audit cannot see" are indistinguishable, and a miss is
 * silent while a false positive is visible.
 */
const boundedTimeout = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  const body = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value)?.[1];
  // A body that reopens a delimiter is two expressions spliced together
  // (`${{ 5 }} ${{ x && 10 || 20 }}`), not one this audit can reason about.
  if (body === undefined || body.includes('{{') || body.includes('}}')) return false;
  const alternatives = splitTopLevel(body, '||');
  if (alternatives.length === 1) return positiveIntegerBranch(body);
  if (alternatives.length !== 2) return false;
  const conjuncts = splitTopLevel(alternatives[0], '&&');
  return conjuncts.length >= 2
    && conjuncts.slice(0, -1).every((conjunct) => conjunct.trim() !== '')
    && positiveIntegerBranch(conjuncts.at(-1))
    && positiveIntegerBranch(alternatives[1]);
};

/** Only primitives are stringified: a YAML anchor can make the value a
 *  self-referential node, and `JSON.stringify` throws on one, which would crash
 *  the audit instead of reporting the job. */
const describeValue = (value) => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  return Array.isArray(value) ? 'a list' : 'a mapping';
};

const displayPath = (root, path) => relative(root, path).replaceAll('\\', '/');
const permitsFailure = (value) => value !== undefined && value !== false;
const configuredShell = (owner) => isRecord(owner?.defaults) && isRecord(owner.defaults.run) ? owner.defaults.run.shell : undefined;

const REQUIRED_STEPS = new Map([
  ['sdk-canary.yml', ['Run canary bundles']],
  ['test.yml', ['Assert the census target contains runnable tests']],
  ['determinism.yml', ['Assert native determinism targets contain runnable tests']],
  ['python-wheels.yml', ['Assert the complete wheel matrix arrived']],
]);
const REQUIRED_STEP_RUN = new Map([
  ['Run canary bundles', 'node scripts/ci-run-sdk-canaries.mjs'],
  ['Assert the census target contains runnable tests', 'node scripts/ci-assert-runnable-cargo-tests.mjs --package ifc-lite-geometry --features triangulation-alt --test triangulation_invariance'],
  ['Assert native determinism targets contain runnable tests', 'node scripts/ci-assert-native-determinism-tests.mjs'],
  ['Assert the complete wheel matrix arrived', 'node scripts/ci-prepare-wheel-matrix.mjs'],
]);
const REPORTER_NEEDS = new Map([
  ['determinism.yml', ['arm64-determinism', 'wasm32-mesh-determinism']],
  ['export-schema-conformance.yml', ['validate']],
  ['ifcopenshell-parity.yml', ['full', 'cost-full']],
  ['wide-arithmetic.yml', ['wide-arithmetic-tripwire']],
  ['xmatch-fixture.yml', ['content-matching-fixture']],
]);

const normalizeCondition = (value) => expression(value).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\s+/g, ' ').trim();
const nonSuccessCondition = (dependencies) => {
  const checks = dependencies.map((dependency) => `needs.${dependency}.result != 'success'`);
  return checks.length === 1 ? checks[0] : `(${checks.join(' || ')})`;
};

export function auditRoot(root) {
  const failures = [];
  const workflowDir = join(root, '.github', 'workflows');
  if (!existsSync(workflowDir)) return ['.github/workflows is missing; no workflow reporting paths were audited'];
  const paths = filesBelow(workflowDir, (file) => /\.ya?ml$/.test(file));
  if (paths.length === 0) return ['.github/workflows contains no YAML workflows'];
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    const name = basename(path);
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      failures.push(`${displayPath(root, path)}: invalid YAML: ${document.errors[0].message}`);
      continue;
    }
    const workflow = document.toJS();
    if (!isRecord(workflow) || !isRecord(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
      failures.push(`${displayPath(root, path)}: missing parseable jobs tree`);
      continue;
    }
    const jobs = workflow.jobs;
    for (const [id, job] of Object.entries(jobs)) {
      const callsReusableWorkflow = isRecord(job) && typeof job.uses === 'string';
      if (!callsReusableWorkflow && (!isRecord(job) || typeof job['runs-on'] !== 'string')) failures.push(`${displayPath(root, path)}: job ${id} has no runs-on or reusable workflow`);
      if (!callsReusableWorkflow && (!isRecord(job) || !boundedTimeout(job['timeout-minutes']))) {
        const value = isRecord(job) ? job['timeout-minutes'] : undefined;
        failures.push(value === undefined
          ? `${displayPath(root, path)}: job ${id} has no timeout-minutes`
          : `${displayPath(root, path)}: job ${id} has a timeout-minutes this audit cannot prove bounded: ${describeValue(value)}`);
      }
    }
    for (const stepName of REQUIRED_STEPS.get(name) ?? []) {
      const owner = Object.values(jobs).find((job) => namedStep(job, stepName));
      const step = namedStep(owner, stepName);
      const run = expression(step?.run);
      if (!isRecord(owner) || permitsFailure(owner['continue-on-error'])
        || !step || typeof step.run !== 'string' || run.trim() !== REQUIRED_STEP_RUN.get(stepName)
        || step.if !== undefined || permitsFailure(step['continue-on-error']) || step.shell !== undefined
        || configuredShell(workflow) !== undefined || configuredShell(owner) !== undefined) {
        failures.push(`${displayPath(root, path)}: missing active fail-closed step: ${stepName}`);
      }
    }
    if (name === 'docs.yml') {
      const buildJob = jobs.build;
      const rustdocCopy = namedStep(buildJob, 'Copy Rustdoc to site');
      if (!rustdocCopy || !expression(rustdocCopy.run).includes('node scripts/build-rustdoc-index.mjs target/doc site/api/rust/index.html')) {
        failures.push(`${displayPath(root, path)}: Rustdoc copy does not generate the deployed landing page`);
      }
      const verify = namedStep(buildJob, 'Verify site structure');
      if (!isRecord(buildJob) || buildJob['continue-on-error'] === true
        || !expression(verify?.run).includes('test -f site/index.html')
        || !expression(verify?.run).includes('test -f site/api/rust/index.html')) {
        failures.push(`${displayPath(root, path)}: docs build does not fail closed on either deployed entry point`);
      }
    }
    if (name === 'python-wheels.yml') {
      const publishJob = Object.values(jobs).find((job) => namedStep(job, 'Assert the complete wheel matrix arrived'));
      const publishSteps = stepsOf(publishJob);
      const wheelGate = namedStep(publishJob, 'Assert the complete wheel matrix arrived');
      const checkoutIndex = publishSteps.findIndex((step) => expression(step.uses).startsWith('actions/checkout@'));
      const gateIndex = publishSteps.indexOf(wheelGate);
      const publisher = Object.values(jobs).flatMap(stepsOf).find((step) => expression(step.uses).startsWith('pypa/gh-action-pypi-publish@'));
      if (expression(wheelGate?.run).trim() !== REQUIRED_STEP_RUN.get('Assert the complete wheel matrix arrived')
        || checkoutIndex < 0 || checkoutIndex >= gateIndex
        || !isRecord(publishJob?.permissions) || publishJob.permissions.contents !== 'read'
        || !isRecord(publisher?.with) || publisher.with['packages-dir'] !== 'dist/publish') {
        failures.push(`${displayPath(root, path)}: wheel publish gate does not prove every matrix leg independently`);
      }
    }
    if (REPORTER_NEEDS.has(name)) {
      const reporter = jobs['report-scheduled-failure'];
      const condition = normalizeCondition(reporter?.if);
      const dependencies = REPORTER_NEEDS.get(name);
      const workflowPermissions = isRecord(workflow.permissions) ? workflow.permissions : {};
      const expectedCondition = `always() && github.event_name == 'schedule' && ${nonSuccessCondition(dependencies)}`;
      if (!isRecord(reporter) || reporter.uses !== './.github/workflows/report-scheduled-failure.yml'
        || condition !== expectedCondition
        || !dependencies.every((dependency) => needs(reporter, dependency))
        || workflowPermissions.issues === 'write') {
        failures.push(`${displayPath(root, path)}: missing active scheduled failure reporter with complete needs`);
      }
    }
    for (const step of Object.values(jobs).flatMap(stepsOf).filter((candidate) => expression(candidate.uses).startsWith('actions/upload-artifact@'))) {
      if (!isRecord(step.with) || step.with['if-no-files-found'] !== 'error') {
        failures.push(`${displayPath(root, path)}: artifact upload does not fail when its input is absent`);
      }
    }
    if (name === 'python-wheels.yml' || name === 'server-binaries.yml') {
      const reporter = jobs['report-red-on-main'];
      const expected = name === 'python-wheels.yml' ? ['build', 'build-cross'] : ['validate-server-binaries', 'validate-server-binaries-cross'];
      const condition = normalizeCondition(reporter?.if);
      const expectedCondition = `always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && ${nonSuccessCondition(expected)}`;
      if (!isRecord(reporter) || condition !== expectedCondition
        || !expected.every((dependency) => needs(reporter, dependency))
        || !isRecord(reporter.permissions) || reporter.permissions.issues !== 'write') {
        failures.push(`${displayPath(root, path)}: partial main-only matrix has no active issue reporter disposition`);
      }
    }
    if (name === 'review-lane-canary.yml') {
      const canary = jobs.canary;
      for (const stepName of ['Raise or update the ops issue', 'Fail the run if the lane is down']) {
        const condition = expression(namedStep(canary, stepName)?.if);
        if (!condition.includes('always()') || !condition.includes("steps.canary.outputs.rc != '0'")) {
          failures.push(`${displayPath(root, path)}: ${stepName} does not handle a missing canary result`);
        }
      }
    }
    if (name === 'release.yml') {
      for (const id of ['verify-npm-publish', 'verify-crates-publish']) {
        const condition = expression(isRecord(jobs[id]) ? jobs[id].if : undefined);
        if (!condition.includes('always()') || !condition.includes("needs.release.outputs.verify != 'false'")) {
          failures.push(`${displayPath(root, path)}: ${id} skips when the producer output is absent`);
        }
      }
    }
    if (name === 'ci-reporting-outcome-probe.yml') {
      const reporter = jobs.report;
      const deadline = namedStep(jobs.subject, 'Turn a real hang into a failed inner deadline');
      if (!isRecord(jobs.subject) || !isRecord(reporter) || !needs(reporter, 'subject')
        || !expression(reporter.if).includes('always()')
        || reporter.uses !== './.github/workflows/report-scheduled-failure.yml'
        || !isRecord(reporter.with)
        || !expression(reporter.with.result).includes('needs.subject.result')
        || !expression(reporter.with.result).includes('needs.subject.outputs.evidence')
        || !expression(reporter.with.result).includes('needs.subject.outputs.deadline')
        || !expression(deadline?.run).includes('timeout --signal=TERM')
        || !expression(deadline?.run).includes('exit "$rc"')) {
        failures.push(`${displayPath(root, path)}: probe does not route the actual dependency result and absent output through the reporter`);
      }
    }
    if (name === 'ci-reporting-cancellation-observer.yml') {
      const reporter = jobs['report-cancelled'];
      if (!isRecord(reporter)
        || !expression(reporter.if).includes("workflow_run.conclusion == 'cancelled'")
        || reporter.uses !== './.github/workflows/report-scheduled-failure.yml'
        || !isRecord(reporter.with)
        || expression(reporter.with.result) !== `\${{ github.event.workflow_run.conclusion }}`) {
        failures.push(`${displayPath(root, path)}: cancellation observer does not route the actual completed workflow conclusion`);
      }
    }
  }

  for (const parent of ['packages', 'apps']) {
    for (const path of filesBelow(join(root, parent), (file) => basename(file) === 'package.json')) {
      if (readFileSync(path, 'utf8').includes('--passWithNoTests')) {
        failures.push(`${displayPath(root, path)}: test command permits zero collected tests`);
      }
    }
  }
  return failures;
}

export function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? join(fileURLToPath(new URL('.', import.meta.url)), '..') : argv[rootIndex + 1];
  if (!root) throw new Error('--root requires a directory');
  const failures = auditRoot(root);
  if (failures.length > 0) {
    console.error(failures.map((failure) => `ERROR: ${failure}`).join('\n'));
    return 1;
  }
  console.log('Workflow report-path audit passed.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
