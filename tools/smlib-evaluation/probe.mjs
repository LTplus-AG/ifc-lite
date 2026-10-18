// SPDX-License-Identifier: MPL-2.0
// Usage: node probe.mjs /absolute/build/smlib_probe.mjs
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (process.argv.length !== 3) throw new Error('Pass the built smlib_probe.mjs path');
const { default: createProbe } = await import(pathToFileURL(resolve(process.argv[2])).href);
const instance = await createProbe();
const result = JSON.parse(instance.UTF8ToString(instance._run_probe()));
console.log(JSON.stringify(result));
if (result.passed !== true || result.cases?.length !== 10) process.exitCode = 1;
