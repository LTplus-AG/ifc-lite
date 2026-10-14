/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-FILE wall time from a `Viewer tests (shard n)` job log.
 *
 * node:test's TAP output names tests, never files. But with
 * `--test-concurrency=1` the files of a shard run one after another in the
 * order they were passed (sorted), and each top-level `ok N - <title>` line
 * carries the runner's timestamp. So:
 *
 *  1. every top-level title is matched to the EARLIEST file, at or after the
 *     previous match, whose source declares that title (a string literal, or
 *     a template literal with its `${...}` holes as wildcards);
 *  2. a file's span runs from its first top-level test's start (result time
 *     minus that test's `duration_ms`) to its last result. The gap between
 *     one file's last result and the next file's first test is the old
 *     process lingering plus the new one starting: the shard's median gap is
 *     charged to the starting file as startup, any excess to the file BEFORE
 *     it (a finished test file that does not exit, which measured as the
 *     common case: see attributeFiles). Everything from the `TAP version 13`
 *     line to the `# duration_ms` summary is charged to some file, so the
 *     per-file seconds sum to the step's test wall time exactly. What can be
 *     wrong is a boundary: a file whose import alone exceeds the median is
 *     undercounted by that excess, and its predecessor overcounted.
 *
 * The match is monotone (files run in order), so an ambiguous title can only
 * resolve forwards. `unmatched` and `silentFiles` are returned so the caller
 * can report how much of the attribution was inferred rather than matched.
 */

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z (.*)$/;
const TOP_LEVEL_RESULT = /^(?:not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/;
const TOP_LEVEL_DURATION = /^ {2}duration_ms: ([\d.]+)$/;

/** Undo node's TAP title escaping. */
function unescapeTitle(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/**
 * Top-level results of the (single) TAP stream in a job log.
 * @param {string} log
 * @returns {{ start: number, end: number, results: { t: number, title: string, ms: number }[] }}
 */
export function parseTapLog(log) {
  let start = null;
  let end = null;
  const results = [];
  for (const raw of log.split('\n')) {
    const m = STAMP.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const t = Date.parse(`${m[1]}Z`);
    const body = m[2];
    if (start === null) {
      if (body === 'TAP version 13') start = t;
      continue;
    }
    const r = TOP_LEVEL_RESULT.exec(body);
    if (r) {
      results.push({ t, title: unescapeTitle(r[1]), ms: 0 });
      continue;
    }
    const d = TOP_LEVEL_DURATION.exec(body);
    if (d && results.length > 0) {
      results[results.length - 1].ms = Number(d[1]);
      continue;
    }
    if (body.startsWith('# duration_ms ')) {
      end = t;
      break;
    }
  }
  if (start === null || end === null) throw new Error('log holds no complete TAP stream (no "TAP version 13" ... "# duration_ms")');
  return { start, end, results };
}

/**
 * Titles a test source declares: exact strings, and RegExps for template
 * literals with interpolation.
 * @param {string} src
 * @returns {(string | RegExp)[]}
 */
export function declaredTitles(src) {
  const out = [];
  const call = /\b(?:test|it|describe|suite)(?:\.(?:skip|only|todo))?\(\s*(['"`])/g;
  let m;
  while ((m = call.exec(src))) {
    const quote = m[1];
    const parts = [];
    let lit = '';
    let i = call.lastIndex;
    while (i < src.length && src[i] !== quote) {
      const c = src[i];
      if (c === '\\') {
        const e = src[i + 1];
        lit += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        i += 2;
      } else if (quote === '`' && c === '$' && src[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        parts.push(lit);
        lit = '';
      } else {
        lit += c;
        i++;
      }
    }
    parts.push(lit);
    if (parts.length === 1) {
      out.push(parts[0]);
    } else if (parts.join('').trim().length >= 6) {
      // Too little literal text would match anything; such titles stay unmatched.
      const body = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?');
      out.push(new RegExp(`^${body}$`));
    }
  }
  return out;
}

function declares(src, titles, title) {
  if (src.includes(title)) return true;
  return titles.some((d) => (typeof d === 'string' ? d === title : d.test(title)));
}

/**
 * Attribute a shard's wall time to its files.
 * @param {string[]} files the shard's files in execution order
 * @param {string[]} sources their source text, same order
 * @param {{ start: number, end: number, results: { t: number, title: string, ms: number }[] }} tap
 * @returns {{ seconds: Map<string, number>, unmatched: string[], silentFiles: string[], wall: number }}
 */
export function attributeFiles(files, sources, tap) {
  const titles = sources.map(declaredTitles);
  const unmatched = [];
  const lastResultOf = new Array(files.length).fill(-1);
  const assigned = new Array(tap.results.length);
  let at = 0;
  tap.results.forEach((r, k) => {
    let found = -1;
    for (let i = at; i < files.length; i++) {
      if (declares(sources[i], titles[i], r.title)) {
        found = i;
        break;
      }
    }
    if (found < 0) unmatched.push(r.title);
    else at = found;
    lastResultOf[at] = k;
    assigned[k] = at;
  });

  // Per file that produced results: when its first top-level test started
  // (result time minus that test's own duration) and when its last ended.
  const firstResultOf = new Array(files.length).fill(-1);
  lastResultOf.forEach((k, i) => {
    if (k < 0) return;
    let first = k;
    while (first > 0 && assigned[first - 1] === i) first--;
    firstResultOf[i] = first;
  });
  const spans = [];
  let prevEnd = tap.start;
  files.forEach((f, i) => {
    if (lastResultOf[i] < 0) return;
    const first = tap.results[firstResultOf[i]];
    const end = tap.results[lastResultOf[i]].t;
    const testStart = Math.min(end, Math.max(prevEnd, first.t - first.ms));
    spans.push({ i, gap: (testStart - prevEnd) / 1000, body: (end - testStart) / 1000 });
    prevEnd = end;
  });

  // The gap before a file's first test is the previous process lingering
  // plus this one starting. The typical gap (the shard's median) is charged
  // to the starting file as its startup; any excess goes to the PREVIOUS
  // file, because the excess measured is a finished process that does not
  // exit. Measured locally, one file at a time: FlavorDialog.unapplied-toast
  // 73 s and its successor extensions-tabs.keyboard 9 s, which charging
  // the gap forwards had swapped (7 s and 64 s); likewise PrivacyPanel.i18n
  // 67 s (forwards: 12 s) and ViewportWelcomeCard.privacy 38 s against its
  // successor ModelAuthoringCurtainWall 7 s (forwards: 5 s and 35 s).
  const typical = spans.length > 0 ? median(spans.map((s) => s.gap)) : 0;
  const seconds = new Map(files.map((f) => [f, 0]));
  const add = (i, x) => seconds.set(files[i], seconds.get(files[i]) + x);
  const silentFiles = files.filter((_, i) => lastResultOf[i] < 0);
  let prevIdx = -1;
  for (const { i, gap, body } of spans) {
    // Silent files between the previous span and this one: each gets a
    // typical startup out of this gap, as far as the gap reaches.
    let rest = gap;
    for (let k = prevIdx + 1; k < i; k++) {
      const take = Math.min(rest, typical);
      add(k, take);
      rest -= take;
    }
    const startup = Math.min(rest, typical);
    add(i, startup + body);
    add(prevIdx >= 0 ? prevIdx : i, rest - startup);
    prevIdx = i;
  }
  // After the last result: that process lingering, plus any trailing silent files.
  let tail = (tap.end - prevEnd) / 1000;
  for (let k = prevIdx + 1; k < files.length; k++) {
    const take = Math.min(tail, typical);
    add(k, take);
    tail -= take;
  }
  if (files.length > 0) add(prevIdx >= 0 ? prevIdx : files.length - 1, tail);
  return { seconds, unmatched, silentFiles, wall: (tap.end - tap.start) / 1000 };
}

/** Median of a non-empty list. */
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
