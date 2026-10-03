/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { setTimeout as pause } from 'node:timers/promises';

export function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), pgrp: Number(fields[2]), state: fields[0], startTime: fields[19] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

export async function finishLog(log, timeoutMs) {
  let timer;
  const flushed = finished(log); // Subscribe before end; includes write failures.
  log.end();
  try {
    await Promise.race([flushed, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned log flush deadline')), timeoutMs);
    })]);
    return { status: 'complete' };
  } catch (error) { log.destroy(); return { status: 'refused', reason: String(error) }; }
  finally { clearTimeout(timer); }
}

// PID/start-time fences prevent signalling a reused PID. Witnesses come solely
// from the spawned sample's observed descendants. Zombies retain no live work.
export async function stopWitnessedProcesses(witnesses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [], zombies = 0;
  do {
    remaining = []; zombies = 0;
    for (const witness of witnesses) {
      const current = processIdentity(witness.pid);
      if (!current || current.startTime !== witness.startTime) continue;
      if (current.state === 'Z') { zombies++; continue; }
      remaining.push(current.pid);
      try { process.kill(current.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') return { status: 'refused', reason: String(error), remaining }; }
    }
    if (!remaining.length) return { status: 'complete', witnessed: witnesses.length, zombies, remaining };
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { status: 'refused', reason: 'Owned descendant cleanup deadline', witnessed: witnesses.length, zombies, remaining };
}
