/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym pilot worker process (forked by run-pilot.mjs).
 *
 * Receives `{ seed, family }` jobs over IPC, generates + labels the model,
 * optionally writes the IFC file into the shared output directory, and
 * sends the manifest line + timing back to the parent. One worker handles
 * many jobs sequentially. With the default in-process label engine the
 * worker warms one GeometryProcessor at init and amortizes it across every
 * job it handles - the v1 design (two fresh CLI subprocesses per model) is
 * still available via engine: 'subprocess'.
 *
 * keepFiles=false skips the disk write entirely (the in-process labeler
 * reads from memory); any model is reproducible from its seed, so a corpus
 * run only needs the manifest.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateModel } from './generator.mjs';
import { labelModel } from './labeler.mjs';
import { initChecks } from './lib/checks.mjs';

let modelDir;
let skipChecks = false;
let engine = 'in-process';
let corruptRate = 0;
let keepFiles = true;
let ready = false;

process.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      modelDir = msg.modelDir;
      skipChecks = !!msg.skipChecks;
      engine = msg.engine ?? 'in-process';
      corruptRate = msg.corruptRate ?? 0;
      keepFiles = msg.keepFiles !== false;
      if (keepFiles) await mkdir(modelDir, { recursive: true });
      if (engine === 'in-process' && !skipChecks) await initChecks();
      ready = true;
      process.send({ type: 'ready' });
    } catch (err) {
      // A failed init (missing dist build, unwritable modelDir, wasm init
      // failure) must not leave the parent waiting on 'ready' forever:
      // report the reason, then exit so the pool's death handler rejects
      // this worker's readiness promise.
      process.send({ type: 'init-error', error: err?.stack ?? String(err) });
      process.exit(1);
    }
    return;
  }

  if (msg.type === 'job') {
    if (!ready) {
      process.send({ type: 'error', seed: msg.seed, error: 'worker not initialized' });
      return;
    }
    const t0 = performance.now();
    try {
      const model = generateModel(msg.seed, msg.family, { corruptRate });
      const genTimeMs = performance.now() - t0;
      const filePath = join(modelDir, `${model.family}-${msg.seed}.ifc`);
      if (keepFiles) await writeFile(filePath, model.content, 'utf-8');
      const line = await labelModel(model, filePath, { skipChecks, engine });
      if (!keepFiles) line.file = null;
      process.send({
        type: 'result',
        seed: msg.seed,
        line,
        genTimeMs: Math.round(genTimeMs),
        totalTimeMs: Math.round(performance.now() - t0),
      });
    } catch (err) {
      process.send({
        type: 'error',
        seed: msg.seed,
        error: String(err.stack ?? err.message ?? err),
      });
    }
    return;
  }

  if (msg.type === 'shutdown') {
    process.exit(0);
  }
});
