/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DirtyPrScanError } from './dirty-pr-scan.mjs';

/**
 * `cadenceReport` is the scan-reports-on-itself half of #3776. Split out of
 * `dirty-pr-scan.mjs` for the same reason `workflow-base-branches.mjs` was:
 * it is pure arithmetic over two timestamps with no dependency on PR
 * classification, and that file is at its size budget. `dirty-pr-scan.mjs`
 * re-exports it so existing imports are unaffected.
 */
/**
 * How long it has been since this scan last ran, as report lines plus an
 * optional annotation (issue #3776).
 *
 * WHY A SCAN REPORTS ON ITSELF: `dirty-pr-scan.yml` ran on a 30-minute cron and
 * GitHub delivered ONE run in four hours, so `main` carried that run's
 * four-hour-old failure -- naming PRs that had since been retargeted and gone
 * green -- and nothing said the verdict was old. Scheduled triggers are
 * best-effort and no in-repo change makes them reliable. What a run CAN do is
 * say how long the gap before it was, so a missed window leaves a trace
 * afterwards instead of being an absence someone has to notice. That is the
 * same blind spot this workflow exists to close, one level up.
 *
 * NOTHING HERE THROWS ON BAD INPUT except a caller mistake (a nonsensical
 * interval). A cadence report is commentary on the scan, not the scan: a
 * malformed timestamp or a `gh` failure must degrade to "unknown", loudly,
 * rather than fail a job whose actual output is the PR findings. `ghError`
 * exists so the caller can pass that failure in and get the unknown verdict
 * instead of the healthy "no earlier run" one -- those two are NOT the same
 * fact, and reporting the second for the first is exactly the
 * absence-reads-as-success shape this file argues against elsewhere.
 *
 * @param {object} o
 * @param {string | null | undefined} o.previousCreatedAt - ISO timestamp of the
 *   newest earlier run, or null/undefined when there is none.
 * @param {Date | string | number} o.now
 * @param {number} o.cronMinutes - the declared cron interval; stale is two
 *   missed ticks, since one is routine for a best-effort schedule.
 * @param {string | null} [o.ghError] - why the run history could not be read.
 * @returns {{ lines: string[], warning: string | null, stale: boolean }}
 */
export function cadenceReport({ previousCreatedAt, now, cronMinutes, ghError = null }) {
  if (!Number.isFinite(cronMinutes) || cronMinutes <= 0) {
    throw new DirtyPrScanError(
      'BAD_CADENCE_INTERVAL',
      `The cron interval must be a positive number of minutes; got \`${cronMinutes}\`. A zero or ` +
        'negative interval makes every gap stale, which is a wrong verdict rather than a missing one.',
    );
  }
  const head = 'Scan cadence:';
  /** @param {string} why */
  const unknown = (why) => ({
    lines: [head, `   ⚠️  Cadence unknown: ${why}`],
    warning:
      `Silent PR CI visibility could not establish when it last ran (${why}), so a missed ` +
      'window would leave no trace.',
    stale: false,
  });

  if (ghError) return unknown(ghError);

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return unknown(`the current time did not parse (\`${now}\`)`);

  if (previousCreatedAt === null || previousCreatedAt === undefined || previousCreatedAt === '') {
    return {
      lines: [head, '   No earlier completed run was visible, so there is no gap to measure.'],
      warning: null,
      stale: false,
    };
  }

  const prevMs = Date.parse(String(previousCreatedAt));
  if (!Number.isFinite(prevMs)) {
    return unknown(`the previous run's timestamp did not parse (\`${previousCreatedAt}\`)`);
  }
  const minutes = Math.round((nowMs - prevMs) / 60000);
  if (minutes < 0) {
    return unknown(`the previous run (${previousCreatedAt}) is in the future relative to this one`);
  }

  const lines = [
    head,
    `   Previous run: ${previousCreatedAt} (${minutes} minute(s) ago); cron interval is ` +
      `${cronMinutes} minute(s).`,
  ];
  // Two missed ticks. One is routine for a best-effort cron and is not worth
  // an annotation nobody can act on.
  if (minutes <= cronMinutes * 2) return { lines, warning: null, stale: false };

  lines.push(
    `   ⚠️  STALE: \`main\` carried this scan's previous verdict for ${minutes} minute(s).`,
  );
  return {
    lines,
    warning:
      `Silent PR CI visibility last ran ${minutes} minutes ago on a ${cronMinutes}-minute cron ` +
      '(#3776), so its verdict on main was stale for that window.',
    stale: true,
  };
}
