/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { beginNightAttempt, finishNightAttempt, readNightAttempts } from './frame-gpu-night-attempt.js';
import { nightHistoryWindow, type NightAttempt } from './frame-gpu-night-history.js';
import { verifyNightProfile, sha256 } from './frame-gpu-night-profile.js';
import { readHostProfile } from './frame-gpu-night-admission.js';
import { NightAdmissionRefusal, requireNightLease, requireNightWindow, watchNightLease, type NightAuthority, type NightWindow } from './frame-gpu-night-lease.js';
import { runNightProcess, type NightProcessResult } from './frame-gpu-night-process.js';
import { nightArtifactHashes, requireNightEvidence, requireAttemptRetirement } from './frame-gpu-night-evidence.js';

import { acquireNightLease, type AcquiredNightLease } from './frame-gpu-night-acquire.js';

export interface NativeNightOptions extends NightWindow {
  checkout: string; profileFile: string; profileSha256: string; outputRoot: string; leaseFile: string;
  /** Pinned standing approval is required only for unattended atomic acquisition. */
  authorization?: { path: string; sha256: string };
}
export interface NativeNightResult {
  attempt: NightAttempt; directory: string; calendarReady: boolean; reason: string;
}

/** A single native launch per scheduled UTC date. Every precondition failure,
 * process error, timeout and cleanup failure keeps the original attempt. Nothing
 * here installs a task, takes an existing lease, retries Chrome or sets a threshold.
 * Standing approved scheduling atomically creates only an absent shared lease.
 */
export async function runNativeNight(options: NativeNightOptions): Promise<NativeNightResult> {
  const checkout = realpathSync(options.checkout);
  mkdirSync(options.outputRoot, { recursive: true });
  const outputRoot = realpathSync(options.outputRoot), local = relative(checkout, outputRoot);
  if (!local || (!local.startsWith('../') && !isAbsolute(local))) throw new Error('night evidence must be outside the clean checkout');
  const profileSha256 = options.profileSha256;
  const handle = beginNightAttempt(outputRoot, profileSha256);
  if (!handle.mayLaunch) {
    const history = nightHistoryWindow(readNightAttempts(outputRoot), handle.initial.night);
    return { attempt: handle.initial, directory: handle.directory, calendarReady: history.calendarReady, reason: history.reason };
  }
  let phase = 'scheduled-window', status: NightAttempt['status'] = 'failed';
  const evidence: Record<string, unknown> = { issue: 6975, requestedWindow: options, profileSha256,
    nativeQualification: 'Actual raw artifacts require independent review; calendar alone sets no threshold' };
  const cancellation = new AbortController();
  let monitor: ReturnType<typeof watchNightLease> | undefined;
  let processResult: NightProcessResult | undefined;
  let acquired: AcquiredNightLease | undefined;
  let rigDirectory: string | undefined;
  let invoked = false;
  try {
    const remaining = requireNightWindow(options);
    if (Date.now() - Date.parse(options.startsAt) > 60_000 || remaining < 165_000) {
      throw new NightAdmissionRefusal('late invocation or insufficient window for native work and owned cleanup');
    }
    phase = 'immutable-source-profile';
    const profileBytes = readFileSync(options.profileFile);
    if (sha256(profileBytes) !== profileSha256) throw new NightAdmissionRefusal('profile bytes differ from scheduled immutable hash');
    const verified = verifyNightProfile(checkout, profileBytes), host = readHostProfile(checkout, verified.profile);
    const authority: NightAuthority = { ...options, checkout, sourceHead: verified.profile.sourceHead, profileSha256 };
    phase = 'exclusive-heavy-lease';
    if (options.authorization) {
      acquired = acquireNightLease({ authorization: options.authorization, leaseFile: options.leaseFile, authority });
      evidence.atomicAcquisition = { token: acquired.token, ownerSHA256: acquired.ownerSHA256 };
    }
    evidence.leaseBefore = requireNightLease(options.leaseFile, authority);
    monitor = watchNightLease(options.leaseFile, authority, cancellation);
    writeFileSync(join(handle.directory, 'invocation-profile.json'), profileBytes, { flag: 'wx', mode: 0o600 });
    rigDirectory = join(handle.directory, 'rig');
    mkdirSync(rigDirectory);
    const sampleBudget = Math.min(600_000, requireNightWindow(options) - 165_000);
    if (sampleBudget <= 0) throw new NightAdmissionRefusal('window ended during source admission');
    const argv = ['flock', '-n', '-E', '75', '/tmp/ifclite-perf.lock', process.execPath,
      join(checkout, 'node_modules/tsx/dist/cli.mjs'), join(checkout, 'scripts/perf/frame-gpu-rig.mts'),
      resolve(checkout, verified.profile.fixture), '--branch-revision', verified.profile.sourceHead, '--pairs', '1',
      '--require-gpu-timing', '--require-physical-display', '--require-host-idle',
      '--chrome', host.browser.executable, '--dist-branch', resolve(checkout, verified.profile.dist),
      '--night-profile', join(handle.directory, 'invocation-profile.json'),
      '--owner-ledger', join(rigDirectory, 'browser-owners'), '--out-dir', rigDirectory,
      '--sample-budget-ms', String(Math.floor(sampleBudget))];
    phase = 'actual-native-rig';
    invoked = true;
    processResult = await runNightProcess({ argv, cwd: checkout, directory: handle.directory,
      budgetMs: sampleBudget + 120_000, cleanupMs: 45_000, signal: cancellation.signal });
    evidence.process = processResult;
    const lease = monitor.stop(); monitor = undefined;
    evidence.leaseInterval = lease;
    if (lease.interruptions || cancellation.signal.aborted) throw new Error('exclusive nightly lease/window interrupted');
    if (processResult.exit === 75) throw new NightAdmissionRefusal('cooperative performance lock held; no native rig launched');
    if (processResult.exit !== 0 || processResult.signal !== null || processResult.timedOut || processResult.cancellation
      || processResult.cleanupError || processResult.liveOwned.length) throw new Error('native rig/process retirement failed; original outputs retained');
    phase = 'actual-native-evidence';
    evidence.nativeSample = requireNightEvidence(rigDirectory, host);
    phase = 'post-source-and-lease';
    verifyNightProfile(checkout, profileBytes);
    evidence.leaseAfter = requireNightLease(options.leaseFile, authority);
    requireNightWindow(options);
    status = 'ok';
  } catch (error) {
    status = error instanceof NightAdmissionRefusal ? 'refused' : 'failed';
    evidence.error = String(error);
  } finally {
    if (monitor) evidence.leaseInterval = monitor.stop();
    if (acquired) {
      try {
        if (invoked && !processResult) throw new Error('child terminal identity receipt unavailable; quarantine nightly lease');
        if (processResult && ((processResult.exit === null && processResult.signal === null) || processResult.cleanupError || processResult.liveOwned.length)) {
          throw new Error('Linux child retirement unproved; quarantine nightly lease');
        }
        if (!invoked) evidence.nativeRetirement = { owners: 0, noBirth: 'controller never invoked its child' };
        else if (processResult?.exit === 75) evidence.nativeRetirement = { owners: 0, noBirth: 'cooperative lock refused before rig invocation' };
        else {
          if (!rigDirectory) throw new Error('actual native custody directory unavailable');
          evidence.nativeRetirement = requireAttemptRetirement(rigDirectory);
        }
        acquired.release();
        evidence.atomicRelease = { released: true, token: acquired.token };
      } catch (error) {
        status = 'failed'; evidence.atomicRelease = { released: false, quarantined: true, error: String(error) };
      }
    }
    evidence.phase = phase; evidence.status = status;
    evidence.process ??= processResult ?? null;
    // Seal failures too. A corrupt raw directory may prevent completion; the
    // initial failed attempt and immutable UTC claim still survive that error.
    evidence.artifacts = nightArtifactHashes(handle.directory);
  }
  const attempt = finishNightAttempt(handle, status, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`));
  const history = nightHistoryWindow(readNightAttempts(outputRoot), attempt.night);
  writeFileSync(join(handle.directory, 'calendar-review.json'), `${JSON.stringify({ ...history,
    alertThreshold: null, nativeAdmissionReviewRequired: true, automaticIssueOrClosure: false }, null, 2)}\n`, { flag: 'wx' });
  return { attempt, directory: handle.directory, calendarReady: history.calendarReady, reason: history.reason };
}
