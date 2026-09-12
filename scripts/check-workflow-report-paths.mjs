/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function workflowJobs(text) {
  const jobsStart = text.search(/^jobs:\r?$/m);
  if (jobsStart === -1) return [];
  const jobs = text.slice(jobsStart);
  const starts = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\r?$/gm)];
  return starts.map((match, index) => ({
    id: match[1],
    text: jobs.slice(match.index, starts[index + 1]?.index ?? jobs.length),
  }));
}

const displayPath = (root, path) => relative(root, path).replaceAll('\\', '/');

function artifactSteps(text) {
  const starts = [...text.matchAll(/^\s+- uses: actions\/upload-artifact@[^\r\n]+/gm)];
  return starts.map((match) => {
    const tailStart = match.index + match[0].length;
    const tail = text.slice(tailStart);
    const next = tail.search(/^\s{6}- (?:name:|uses:)/m);
    return text.slice(match.index, next === -1 ? text.length : tailStart + next);
  });
}

const REQUIRED_EVIDENCE = new Map([
  ['sdk-canary.yml', [
    'tests/extensions/canaries is missing; the SDK canary measured nothing',
    'tests/extensions/canaries contains no bundle directories',
  ]],
  ['test.yml', ['Assert the census target contains runnable tests']],
  ['determinism.yml', ['Assert native determinism targets contain runnable tests']],
  ['python-wheels.yml', ['Assert the complete wheel matrix arrived']],
]);

export function auditRoot(root) {
  const failures = [];
  const workflowDir = join(root, '.github', 'workflows');
  for (const path of filesBelow(workflowDir, (file) => /\.ya?ml$/.test(file))) {
    const text = readFileSync(path, 'utf8');
    const name = basename(path);
    for (const { id, text: job } of workflowJobs(text)) {
      const callsReusableWorkflow = /^    uses:\s*\.\/\.github\/workflows\//m.test(job);
      if (!callsReusableWorkflow && !/^    timeout-minutes:\s*\d+/m.test(job)) {
        failures.push(`${displayPath(root, path)}: job ${id} has no timeout-minutes`);
      }
    }
    for (const evidence of REQUIRED_EVIDENCE.get(name) ?? []) {
      if (!text.includes(evidence)) failures.push(`${displayPath(root, path)}: missing evidence guard: ${evidence}`);
    }
    if (name === 'python-wheels.yml') {
      for (const step of artifactSteps(text)) {
        if (!/if-no-files-found:\s*error/.test(step)) {
          failures.push(`${displayPath(root, path)}: wheel upload does not fail when its artifact is absent`);
        }
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
