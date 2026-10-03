/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Pure source-only classifier. Inspect executable/task tokens, never command text.
const basename = value => String(value ?? '').split('/').at(-1).replace(/\.exe$/i, '');
const nativeCompilers = new Set(['rustc', 'cargo', 'cargo-clippy', 'clippy-driver', 'wasm-pack']);
const nodeFlagsWithValue = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '--inspect-port', '--input-type', '--eval', '-e', '--print', '-p']);
const taskFlagsWithValue = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--cwd', '--reporter', '--config', '--cache-dir', '--concurrency', '--output-logs', '--log-order', '--log-prefix', '--env-mode', '--scope']);

function taskTokens(args) {
  const tokens = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break; // Following tokens are application arguments.
    if (taskFlagsWithValue.has(token)) { index++; continue; }
    if (token.startsWith('-')) continue;
    tokens.push({ value: token, index });
  }
  return tokens;
}

function nodeEntry(args) {
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--test' || token.startsWith('--test=')) return { testRunner: true };
    if (['-e', '--eval', '-p', '--print'].includes(token) || /^(?:--eval|--print)=/.test(token)) return null;
    if (token === '--') return args[index + 1] ? { script: args[index + 1], args: args.slice(index + 2) } : null;
    if (nodeFlagsWithValue.has(token)) { index++; continue; }
    if (token.startsWith('-')) continue;
    return { script: token, args: args.slice(index + 1) };
  }
  return null;
}

function scriptTool(script) {
  const normalized = String(script).replaceAll('\\', '/');
  const name = basename(normalized).replace(/\.(?:cjs|mjs|js)$/, '');
  if (['tsc', '_tsc', 'vitest', 'oxlint', 'pnpm', 'npm', 'turbo', 'vite', 'tsx'].includes(name)) return name;
  // tsx/vitest ship generic cli entry names; match package path, not arbitrary text.
  if (/\/(?:tsx|vitest)\/(?:dist|bin)\/(?:cli|index)(?:\.[cm]?js)?$/.test(normalized)) {
    return normalized.includes('/tsx/') ? 'tsx' : 'vitest';
  }
  if (normalized.endsWith('/npm/bin/npm-cli.js')) return 'npm';
  return null;
}

function toolTask(tool, args, depth = 0) {
  if (depth > 16) return { tool, task: 'known-tool-delegation-depth-refusal' };
  if (nativeCompilers.has(tool) || ['tsc', '_tsc', 'vitest', 'oxlint'].includes(tool)) return { tool, task: 'compiler-or-test' };
  if (tool === 'tsx') return args.includes('--test') ? { tool, task: '--test' } : null;
  if (tool === 'vite') return taskTokens(args)[0]?.value === 'build' ? { tool, task: 'build' } : null;
  if (!['pnpm', 'npm', 'turbo'].includes(tool)) return null;
  const tokens = taskTokens(args);
  if (tokens[0]?.value === 'exec') {
    let position = tokens[0].index + 1;
    while (args[position] === '--') position++;
    const executable = args[position];
    if (!executable) return null;
    return toolTask(scriptTool(executable) ?? basename(executable), args.slice(position + 1), depth + 1);
  }
  const delegated = tokens[0] && (scriptTool(tokens[0].value) ?? basename(tokens[0].value));
  if (tool !== 'turbo' && (nativeCompilers.has(delegated) || ['tsc', 'vitest', 'oxlint', 'tsx', 'turbo', 'vite'].includes(delegated))) {
    return toolTask(delegated, args.slice(tokens[0].index + 1), depth + 1);
  }
  const tasks = tokens[0]?.value === 'run' ? tokens.slice(1) : tokens;
  // npm/pnpm execute one task; Turbo can request multiple tasks in one master.
  const candidates = tool === 'turbo' ? tasks : tasks.slice(0, 1);
  const task = candidates.map(token => token.value).find(name => /^(?:build|test)(?:$|[:.-])|^(?:typecheck|lint|clippy)$/.test(name));
  return task ? { tool, task } : null;
}

/** Returns only actual known executable/master task evidence, never argv payloads.
 * Shell/Python guardians are not their remembered children. The caller scans
 * every live process independently, so an active compiler descendant still blocks.
 * Node eval strings and arbitrary application arguments are not parsed as code.
 */
export function classifyBuildTestProcess(argv, executablePath = '') {
  if (!Array.isArray(argv) || !argv.length) return null;
  const executable = basename(executablePath || argv[0]);
  if (executable === 'rustup' && nativeCompilers.has(basename(argv[0]))) return { executable, tool: basename(argv[0]), task: 'compiler-or-test' };
  if (nativeCompilers.has(executable)) return { executable, tool: executable, task: 'compiler-or-test' };
  if (executable === 'node' || executable === 'nodejs') {
    const entry = nodeEntry(argv.slice(1));
    if (entry?.testRunner) return { executable, tool: 'node', task: '--test' };
    const tool = entry && scriptTool(entry.script);
    const classification = tool && toolTask(tool, entry.args);
    return classification ? { executable, ...classification } : null;
  }
  // Direct tool binaries (including shebang executables when /proc/exe is unavailable).
  const classification = toolTask(scriptTool(executable) ?? executable, argv.slice(1));
  return classification ? { executable, ...classification } : null;
}
