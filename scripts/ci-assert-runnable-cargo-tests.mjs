/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const countTests = (output) => output.split(/\r?\n/).filter((line) => line.trim().endsWith(': test')).length;

export function assertRunnableCargoTests(options, run) {
  if (!options.package || options.tests.length === 0) throw new Error('a package and at least one --test target are required');
  for (const target of options.tests) {
    const base = ['test', '-p', options.package];
    if (options.features) base.push('--features', options.features);
    base.push('--test', target, '--');
    const all = run([...base, '--list']);
    const ignored = run([...base, '--ignored', '--list']);
    const runnable = countTests(all) - countTests(ignored);
    if (runnable <= 0) throw new Error(`${target} selected zero runnable tests`);
    console.log(`${target}: ${runnable} runnable test(s)`);
  }
}

export function parseArgs(argv) {
  const options = { package: '', features: '', tests: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--package' && value) options.package = value;
    else if (argv[i] === '--features' && value) options.features = value;
    else if (argv[i] === '--test' && value) options.tests.push(value);
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    i += 1;
  }
  return options;
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArgs(argv);
  assertRunnableCargoTests(options, (args) => {
    const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`cargo ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
    return result.stdout;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
