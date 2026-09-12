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

const displayPath = (root, path) => relative(root, path).replaceAll('\\', '/');

const REQUIRED_STEPS = new Map([
  ['sdk-canary.yml', ['Run canary bundles']],
  ['test.yml', ['Assert the census target contains runnable tests']],
  ['determinism.yml', ['Assert native determinism targets contain runnable tests']],
  ['python-wheels.yml', ['Assert the complete wheel matrix arrived']],
]);
const REPORTER_NEEDS = new Map([
  ['determinism.yml', ['arm64-determinism', 'wasm32-mesh-determinism']],
  ['export-schema-conformance.yml', ['validate']],
  ['ifcopenshell-parity.yml', ['full']],
  ['wide-arithmetic.yml', ['wide-arithmetic-tripwire']],
  ['xmatch-fixture.yml', ['content-matching-fixture']],
]);

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
      if (!callsReusableWorkflow && (!isRecord(job) || !Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0)) {
        failures.push(`${displayPath(root, path)}: job ${id} has no timeout-minutes`);
      }
    }
    for (const stepName of REQUIRED_STEPS.get(name) ?? []) {
      const owner = Object.values(jobs).find((job) => namedStep(job, stepName));
      const step = namedStep(owner, stepName);
      if (!isRecord(owner) || owner['continue-on-error'] === true
        || !step || typeof step.run !== 'string' || !/\bexit\s+1\b/.test(step.run)
        || step.if !== undefined || step['continue-on-error'] === true) {
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
      const wheelGate = Object.values(jobs).map((job) => namedStep(job, 'Assert the complete wheel matrix arrived')).find(Boolean);
      const artifacts = ['wheels-ubuntu-latest-x86_64', 'wheels-ubuntu-latest-aarch64', 'wheels-macos-14-aarch64', 'wheels-macos-14-x86_64', 'wheels-windows-latest-x64'];
      const publisher = Object.values(jobs).flatMap(stepsOf).find((step) => expression(step.uses).startsWith('pypa/gh-action-pypi-publish@'));
      if (!artifacts.every((artifact) => expression(wheelGate?.run).includes(artifact))
        || !isRecord(publisher?.with) || publisher.with['packages-dir'] !== 'dist/publish') {
        failures.push(`${displayPath(root, path)}: wheel publish gate does not prove every matrix leg independently`);
      }
    }
    if (REPORTER_NEEDS.has(name)) {
      const reporter = jobs['report-scheduled-failure'];
      if (!isRecord(reporter) || reporter.uses !== './.github/workflows/report-scheduled-failure.yml'
        || !expression(reporter.if).includes("always()") || !expression(reporter.if).includes("event_name == 'schedule'")
        || !REPORTER_NEEDS.get(name).every((dependency) => needs(reporter, dependency))) {
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
      if (!isRecord(reporter) || !expression(reporter.if).includes('always()') || !expression(reporter.if).includes('refs/heads/main')
        || !expected.every((dependency) => needs(reporter, dependency)) || !isRecord(reporter.permissions) || reporter.permissions.issues !== 'write') {
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
