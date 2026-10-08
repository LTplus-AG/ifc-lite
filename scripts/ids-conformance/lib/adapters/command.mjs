/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A command-line engine adapter: how an engine in another runtime (Python,
 * .NET, a native binary) joins the IDS conformance dashboard without this
 * repository depending on it.
 *
 * Configured by a JSON file passed as `--engine-config <file>`:
 *
 *   {
 *     "id": "my-engine", "name": "My engine", "version": "1.2.3",
 *     "licence": "MIT", "source": "https://pypi.org/project/…",
 *     "notes": ["how verdicts are derived"],
 *     "validate": ["python3", "-I", "bridge.py", "{ids}", "{ifc}"],
 *     "audit": ["some-tool", "audit", "{ids}"]
 *   }
 *
 * `validate` and `audit` are argv arrays (no shell); `{ids}`, `{ifc}` and
 * `{id}` are replaced per case. Either may be omitted. The command prints
 * one JSON object on stdout: `{"verdict": "pass" | "fail" | "valid" |
 * "invalid"}` or `{"verdict": "unsupported", "reason": "…"}`. A non-zero exit,
 * a timeout or unparseable output is an `error` cell.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { UnsupportedCase } from '../matrix.mjs';

const TIMEOUT_MS = 120_000;
const ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @param {string[]} argv
 * @param {import('../matrix.mjs').CaseInput} input
 * @returns {Promise<string>}
 */
function runCommand(argv, input) {
  const [file, ...args] = argv.map((a) => a.replaceAll('{ids}', input.idsPath).replaceAll('{ifc}', input.ifcPath).replaceAll('{id}', input.id));
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${file} failed: ${err.message.split('\n')[0]}${stderr ? ` (${stderr.trim().split('\n').pop()})` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * @param {string} stdout
 * @param {readonly string[]} allowed
 */
export function parseVerdict(stdout, allowed) {
  const line = stdout.trim().split('\n').pop() ?? '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`engine output is not JSON: ${line.slice(0, 120)}`);
  }
  if (parsed?.verdict === 'unsupported') throw new UnsupportedCase(String(parsed.reason ?? 'unsupported by engine'));
  if (!allowed.includes(parsed?.verdict)) throw new Error(`engine verdict ${JSON.stringify(parsed?.verdict)} is not one of ${allowed.join(', ')}`);
  return parsed.verdict;
}

/**
 * @param {string} configPath
 * @returns {import('../matrix.mjs').EngineAdapter}
 */
export function createCommandAdapter(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const key of ['id', 'name', 'version', 'licence', 'source']) {
    if (typeof config[key] !== 'string' || config[key] === '') throw new Error(`${configPath}: "${key}" must be a non-empty string`);
  }
  if (!ID.test(config.id)) throw new Error(`${configPath}: "id" must match ${ID}`);
  for (const key of ['validate', 'audit']) {
    const argv = config[key];
    if (argv !== undefined && !(Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string'))) {
      throw new Error(`${configPath}: "${key}" must be a non-empty array of strings`);
    }
  }
  if (!config.validate && !config.audit) throw new Error(`${configPath}: needs "validate", "audit" or both`);
  /** @type {import('../matrix.mjs').EngineAdapter} */
  const adapter = {
    info: {
      id: config.id,
      name: config.name,
      version: config.version,
      licence: config.licence,
      source: config.source,
      notes: Array.isArray(config.notes) ? config.notes.map(String) : [],
    },
  };
  if (config.validate) {
    adapter.validate = async (input) => /** @type {'pass' | 'fail'} */ (parseVerdict(await runCommand(config.validate, input), ['pass', 'fail']));
  }
  if (config.audit) {
    adapter.audit = async (input) => /** @type {'valid' | 'invalid'} */ (parseVerdict(await runCommand(config.audit, input), ['valid', 'invalid']));
  }
  return adapter;
}
