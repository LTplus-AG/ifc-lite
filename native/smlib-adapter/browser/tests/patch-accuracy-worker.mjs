// SPDX-License-Identifier: MPL-2.0
// #7955: test-only module executes the native source oracle in a real Worker.
import createModule from './ifclite_smlib_patch_accuracy_worker.mjs';
const output = [];
try {
  const module = await createModule({
    print: (line) => output.push(line), printErr: (line) => output.push(line),
  });
  const status = module._ifclite_patch_accuracy_test();
  postMessage({ passed: status === 0 && output.includes('plane oracle PASS'), status, output });
} catch (error) {
  postMessage({ passed: false, error: String(error), output });
}
