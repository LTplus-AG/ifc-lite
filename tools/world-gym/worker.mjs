/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym pilot worker process (forked by run-pilot.mjs).
 *
 * Receives `{ seed, family }` jobs over IPC, generates + labels the model,
 * writes the IFC file into the shared output directory, and sends the
 * manifest line + timing back to the parent. One worker handles many jobs
 * sequentially (not one process per model) so the CLI-subprocess checks
 * inside labelModel() overlap across the worker pool instead of paying
 * Node startup cost per model.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateModel } from './generator.mjs';
import { labelModel } from './labeler.mjs';

let modelDir;
let skipChecks = false;
let ready = false;

process.on('message', async (msg) => {
  if (msg.type === 'init') {
    modelDir = msg.modelDir;
    skipChecks = !!msg.skipChecks;
    await mkdir(modelDir, { recursive: true });
    ready = true;
    process.send({ type: 'ready' });
    return;
  }

  if (msg.type === 'job') {
    if (!ready) {
      process.send({ type: 'error', seed: msg.seed, error: 'worker not initialized' });
      return;
    }
    const t0 = performance.now();
    try {
      const model = generateModel(msg.seed, msg.family);
      const genTimeMs = performance.now() - t0;
      const filePath = join(modelDir, `${model.family}-${msg.seed}.ifc`);
      await writeFile(filePath, model.content, 'utf-8');
      const line = await labelModel(model, filePath, { skipChecks });
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
