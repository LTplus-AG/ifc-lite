// SPDX-License-Identifier: MPL-2.0
import createProbe from './smlib_probe.mjs';

try {
  const instance = await createProbe();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(JSON.parse(instance.UTF8ToString(instance._run_probe())));
  }
  self.postMessage({ passed: runs.every(run => run.passed === true && run.cases?.length === 10), runs });
} catch (error) {
  self.postMessage({ passed: false, error: String(error) });
}
