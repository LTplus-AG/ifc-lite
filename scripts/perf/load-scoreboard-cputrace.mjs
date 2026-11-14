/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in Chrome trace around one scoreboard open, for CPU time per thread role and stage (trace-cpu-time.mjs).
 *
 * Only the `toplevel` and `blink.user_timing` categories are recorded, buffered inside the browser
 * (`ReturnAsStream`) and read after the open, so nothing crosses the DevTools pipe while the timed open runs.
 * The raw trace is kept gzipped beside the sample, so the summary can be recomputed off-line.
 */

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { TRACE_CATEGORIES, traceCpuTime } from './trace-cpu-time.mjs';

/** Start tracing through a CDP session on `page` (tracing is browser-wide: renderer, GPU and browser processes). */
export async function startCpuTrace(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: TRACE_CATEGORIES, excludedCategories: ['*'] } });
  return cdp;
}

async function readStream(cdp, handle) {
  const chunks = [];
  for (;;) {
    const c = await cdp.send('IO.read', { handle, size: 1 << 20 });
    chunks.push(c.base64Encoded ? Buffer.from(c.data, 'base64') : Buffer.from(c.data, 'utf8'));
    if (c.eof) break;
  }
  await cdp.send('IO.close', { handle }).catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

/** The few heaviest threads are enough in a row; the gzipped trace keeps them all. */
const THREADS_KEPT = 12;

/**
 * Stop tracing, keep the trace gzipped at `file`, and summarize it. Never throws: a trace that cannot be read
 * or summarized is recorded as `cpuTime: { error }`, and the timing row stays valid.
 */
export async function stopCpuTrace(cdp, { spans = null, file = null, completeTimeoutMs = 120000 } = {}) {
  let timer = null, onComplete = null, onClose = null;
  try {
    // Settles on completion, on the session closing (Chrome gone) or after a bound, so a lost browser can never hang
    // the sample; both listeners are removed afterwards (review #10138).
    const complete = new Promise((resolve, reject) => {
      onComplete = resolve;
      onClose = () => reject(new Error('CDP session closed before Tracing.tracingComplete'));
      cdp.once('Tracing.tracingComplete', onComplete);
      cdp.once?.('close', onClose);
      timer = setTimeout(() => reject(new Error(`no Tracing.tracingComplete within ${completeTimeoutMs} ms`)), completeTimeoutMs);
    });
    await cdp.send('Tracing.end');
    const { stream, dataLossOccurred } = await complete;
    const text = await readStream(cdp, stream);
    if (file) writeFileSync(file, gzipSync(text));
    // Chrome dropped events: the retained ones can look complete, so no CPU figure (the raw trace is kept).
    if (dataLossOccurred) return { cpuTraceFile: file, cpuTime: { error: 'Chrome reported trace data loss (dataLossOccurred)', dataLoss: true } };
    const r = traceCpuTime(JSON.parse(text), { spans });
    return { cpuTraceFile: file, cpuTime: { ...r, threads: r.threads.slice(0, THREADS_KEPT) } };
  } catch (err) {
    return { cpuTraceFile: file, cpuTime: { error: String(err?.message ?? err).slice(0, 300) } };
  } finally {
    clearTimeout(timer);
    cdp.off?.('Tracing.tracingComplete', onComplete);
    cdp.off?.('close', onClose);
    await cdp.detach().catch(() => {});
  }
}
