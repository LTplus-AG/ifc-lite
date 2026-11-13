/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WASM build cache keys on scripts/ci-wasm-build.sh and on the env the
 * Plan step sees. A workflow step that calls that script with anything extra
 * (`env:` on the step, `FOO=1 bash …`, a second command in `run:`) builds
 * something the key does not describe. This checks the calling workflow's
 * steps; `plan` turns the cache off for the run when it finds a problem.
 *
 * A line-based reader, not a YAML parser, and deliberately strict: anything
 * it does not recognise as the one allowed shape is a problem, which costs a
 * source build and nothing else.
 */

export const BUILD_SCRIPT = 'scripts/ci-wasm-build.sh';
export const BUILD_RUN = `bash ${BUILD_SCRIPT}`;
const ALLOWED_KEYS = new Set(['name', 'id', 'if', 'run']);

const indentOf = (line) => line.length - line.trimStart().length;
const isCode = (line) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** Problems with the steps of `workflowText` that run the build script. */
export function buildStepProblems(workflowText) {
  const lines = workflowText.split('\n');
  const problems = [];
  const starts = new Set();
  lines.forEach((line, index) => {
    if (!isCode(line) || !line.includes(BUILD_SCRIPT)) return;
    let start = index;
    while (start >= 0 && !/^\s*- /.test(lines[start])) start -= 1;
    if (start < 0) problems.push(`line ${index + 1} names ${BUILD_SCRIPT} outside any step`);
    else starts.add(start);
  });
  if (starts.size === 0) problems.push(`no step runs ${BUILD_RUN}`);
  for (const start of starts) {
    const dash = indentOf(lines[start]);
    const keyIndent = dash + 2;
    const keys = [];
    let run = null;
    for (let i = start; i < lines.length; i += 1) {
      const line = i === start ? `${' '.repeat(keyIndent)}${lines[i].trimStart().slice(2)}` : lines[i];
      if (i > start && isCode(line) && indentOf(line) <= dash) break;
      if (!isCode(line) || indentOf(line) !== keyIndent) continue;
      const match = line.trim().match(/^([\w-]+):(.*)$/);
      if (!match) {
        // A quoted key, a flow mapping, anything not `key:`: not the shape.
        keys.push(line.trim());
        continue;
      }
      keys.push(match[1]);
      if (match[1] === 'run') run = match[2].trim();
    }
    const where = `step at line ${start + 1}`;
    for (const key of keys.filter((k) => !ALLOWED_KEYS.has(k))) problems.push(`${where} sets \`${key}:\``);
    if (run !== BUILD_RUN) problems.push(`${where} runs \`${run ?? '(nothing)'}\`, not exactly \`${BUILD_RUN}\``);
  }
  return problems;
}

/** `.github/workflows/test.yml` out of GITHUB_WORKFLOW_REF (`owner/repo/<path>@<ref>`). */
export function workflowPath(env) {
  const ref = env.GITHUB_WORKFLOW_REF ?? '';
  const prefix = `${env.GITHUB_REPOSITORY ?? ''}/`;
  // The first `@` after the path: a branch name may contain `@`, a workflow
  // path may not.
  const at = ref.indexOf('@', prefix.length);
  if (!env.GITHUB_REPOSITORY || !ref.startsWith(prefix) || at < prefix.length) {
    throw new Error(`cannot locate the calling workflow from GITHUB_WORKFLOW_REF='${ref}'`);
  }
  return ref.slice(prefix.length, at);
}
