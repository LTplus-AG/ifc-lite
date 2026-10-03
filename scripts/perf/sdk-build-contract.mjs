/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Actual Turbo output is producing evidence, never a source-text assertion.
const names = ['geometry', 'data', 'encoding', 'wasm-lifecycle', 'wasm'];
const taskName = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
const groupHeader = new RegExp(`^::group::(${taskName}):build$`);
const prefixedCache = new RegExp(`^(${taskName}):build: (cache [^\\n]+)$`, 'gm');
const fresh = /^cache (?:bypass, force executing|miss, executing) [a-f0-9]+$/;
function groupedTasks(text, total) {
  const groups = new Map(); let active;
  const lines = text.split('\n');
  if (lines.length > 100000) throw new Error('build outcome line bound');
  for (const line of lines) {
    if (line.startsWith('::group::')) {
      const match = groupHeader.exec(line);
      if (!match || active || groups.has(match[1])) throw new Error('invalid/duplicate/nested task group');
      active = { name: match[1], lines: [] };
    } else if (line === '::endgroup::') {
      if (!active) throw new Error('unmatched task group end');
      const cache = active.lines.filter(item => item.startsWith('cache '));
      if (cache.length !== 1 || !fresh.test(cache[0])) throw new Error('task group lacks one fresh execution');
      groups.set(active.name, active.lines.join('\n')); active = undefined;
    } else if (active) active.lines.push(line);
    else if (line.startsWith('cache ')) throw new Error('unowned task cache evidence');
  }
  if (active || groups.size !== total || !names.every(name => groups.has(`@ifc-lite/${name}`))
    || !/^✨ Build complete!$/m.test(groups.get('@ifc-lite/wasm') ?? '')) throw new Error('incomplete grouped SDK/WASM outcomes');
  return 'github-groups';
}
export function buildOutcomes(text) {
  if (Buffer.byteLength(text) > 16 * 1024 ** 2) throw new Error('build outcome log bound');
  const tasks = /^\s*Tasks:\s+(\d+) successful,\s+(\d+) total\s*$/m.exec(text);
  const cache = /^\s*Cached:\s+(\d+) cached,\s+(\d+) total\s*$/m.exec(text);
  const total = Number(tasks?.[2]);
  if (!tasks || !cache || !Number.isSafeInteger(total) || total < names.length || total > 1000
    || tasks[1] !== tasks[2] || Number(cache[1]) !== 0 || cache[2] !== tasks[2]) throw new Error('fresh forced SDK/WASM task outcomes missing');
  let format;
  if (text.includes('::group::')) format = groupedTasks(text, total);
  else {
    const entries = [...text.matchAll(prefixedCache)];
    if (entries.length !== total || new Set(entries.map(item => item[1])).size !== total
      || entries.some(item => !fresh.test(item[2])) || !names.every(name => entries.some(item => item[1] === `@ifc-lite/${name}`))
      || !/^@ifc-lite\/wasm:build: .*Build complete!$/m.test(text)) throw new Error('fresh forced SDK/WASM task outcomes missing');
    format = 'task-prefixes';
  }
  return { successful: Number(tasks[1]), total, cached: Number(cache[1]), names: [...names], format };
}
