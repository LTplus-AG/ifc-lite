/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shadow comparison of the two native-adapter layouts on one commit: the
 * single `native-adapter` job against the split lane jobs. Report only; the
 * flip to the split needs repeated matching runs of this (see the PR that added it).
 *
 *   - verdicts: the monolith's job result against the strict judge's, and each
 *     judged lane's outcome. A lane the monolith never reached (skipped after a
 *     hard failure there) is reported, not counted: the split still runs it.
 *   - witnesses: the set of `sdk witness executed:` markers, and of the
 *     registered cli/viewer markers, per log file.
 *   - references: sha256 of every native reference and comparison product, raw
 *     and with timing fields removed (products.tsv carries `ms`/`cutMs`; some
 *     references carry `*Ms` phases). Only the timing-free hash decides.
 *   - transport: the copies the consumer jobs restored are byte-equal to what
 *     na-native packed.
 *   - timings: from the run's jobs listing when a token is available.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { requiredWitnesses } from '../check-retained-witnesses.mjs';
import { judge, LANES, SPLIT_JUDGE, SPLIT_LANE_JOBS, splitLaneOutcome } from './native-adapter-split.mjs';

/** Only the split has these, by design: the M1 reference and browser parity the single job never fed. */
export const SPLIT_ONLY_MARKERS = { 'retained-browser.log': ['m1_browser_parity'] };
export const SPLIT_ONLY_REFS = ['temp/native-references/m1-native-unit-rectangle.json'];
const TIMING_KEY = /(?:^ms|_ms|Ms)$/;
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const digest = (text) => createHash('sha256').update(text).digest('hex');

/** sha256 of a reference with its timing fields removed. */
export function timingFreeHash(name, bytes) {
  if (name.endsWith('.tsv')) {
    const rows = bytes.toString('utf8').split('\n').map((l) => l.split('\t'));
    const keep = rows[0].map((h, i) => (TIMING_KEY.test(h) ? -1 : i)).filter((i) => i >= 0);
    return digest(rows.map((r) => keep.map((i) => r[i] ?? '').join('\t')).join('\n'));
  }
  if (name.endsWith('.json')) {
    const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIMING_KEY.test(k)).map(([k, x]) => [k, strip(x)])) : v);
    return digest(JSON.stringify(strip(JSON.parse(bytes.toString('utf8')))));
  }
  return digest(bytes);
}

/** Every witness marker in one log: native-style lines and the registered cli/viewer records. */
export function markers(text, registered) {
  const found = new Set();
  for (const raw of stripVTControlCharacters(text).split(/\r?\n/)) {
    const line = raw.replace(/^(?:# |ℹ )/, '');
    const native = line.match(/sdk witness executed: (.+?)\s*$/);
    if (native) found.add(native[1]);
    for (const m of registered) if (line.startsWith(`${m} `)) found.add(m);
  }
  return found;
}

/** One evidence directory (collect's layout): steps, logs and the refs pack manifest. */
function evidence(dir) {
  return {
    steps: readJson(join(dir, 'steps.json'), {}),
    meta: readJson(join(dir, 'meta.json'), {}),
    refs: readJson(join(dir, 'refs', 'manifest.json'), { files: {} }).files,
    logs: existsSync(join(dir, 'logs')) ? readdirSync(join(dir, 'logs')).sort() : [],
    // collect always writes meta.json, so its absence means the evidence never arrived.
    present: existsSync(join(dir, 'meta.json')),
    dir,
  };
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

async function timings(env, fetchImpl = globalThis.fetch) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT = '1', GITHUB_API_URL = 'https://api.github.com' } = env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return { note: 'no token or run id; timings not read' };
  const res = await fetchImpl(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return { note: `jobs listing HTTP ${res.status}; timings not read` };
  const jobs = (await res.json()).jobs ?? [];
  const find = (id) => jobs.find((j) => j.name === id || j.name?.endsWith(` / ${id}`));
  const done = (j) => j?.started_at && j?.completed_at;
  const mono = find('native-adapter');
  const lanes = SPLIT_LANE_JOBS.map((id) => [id, find(id)]);
  const judgeJob = find(SPLIT_JUDGE);
  const out = { perJob: {} };
  if (done(mono)) out.monoMinutes = minutes(mono.started_at, mono.completed_at);
  for (const [id, j] of [...lanes, [SPLIT_JUDGE, judgeJob]]) if (done(j)) out.perJob[id] = { start: j.started_at, minutes: minutes(j.started_at, j.completed_at) };
  const started = lanes.filter(([, j]) => done(j)).map(([, j]) => j.started_at).sort();
  if (started.length > 0 && done(judgeJob)) out.splitCriticalMinutes = minutes(started[0], judgeJob.completed_at);
  out.splitRunnerMinutes = Object.values(out.perJob).reduce((s, j) => s + j.minutes, 0);
  return out;
}

/** The whole comparison; `match` is false on any verdict, lane, witness or timing-free hash difference. */
export async function compareLayouts({ mono: monoDir, split: splitDir, needs, root, env = {}, fetchImpl }) {
  const problems = [];
  const lines = ['## native-adapter: single job vs split (shadow)', ''];
  const mono = evidence(monoDir);
  const split = Object.fromEntries(SPLIT_LANE_JOBS.map((job) => [job, evidence(join(splitDir, `na-split-evidence-${job}`))]));
  // Absent evidence reads as empty steps, logs and references: never let it certify a match.
  for (const [label, e] of [['native-adapter', mono], ...Object.entries(split)]) if (!e.present) problems.push(`no evidence from ${label} (${e.dir}); nothing of it was compared`);
  const monoGreen = needs?.['native-adapter']?.result === 'success';
  const j = judge(needs);
  lines.push(`Verdict: single job **${needs?.['native-adapter']?.result ?? 'absent'}**, split judge **${j.ok ? 'success' : 'failure'}**`);
  if (monoGreen !== j.ok) problems.push(`verdicts differ: single ${monoGreen ? 'green' : 'red'}, split ${j.ok ? 'green' : 'red'} (${j.problems.join('; ')})`);
  for (const id of [...new Set(SPLIT_LANE_JOBS.map((job) => split[job].meta.head).filter(Boolean))]) if (mono.meta.head && id !== mono.meta.head) problems.push(`split job commit ${id} is not the single job's ${mono.meta.head}`);

  lines.push('', '| lane | single job | split |', '|---|---|---|');
  const stepsByJob = Object.fromEntries(SPLIT_LANE_JOBS.map((job) => [job, split[job].steps]));
  for (const lane of LANES) {
    const s = splitLaneOutcome(lane, stepsByJob);
    // FINISH_JOIN has no id in the single job: it passed if the step after it ran.
    const m = lane.mono ? (mono.steps[lane.mono]?.outcome ?? 'absent') : (['success', 'failure'].includes(mono.steps['retained-clippy']?.outcome) ? 'success' : 'not reached');
    const counted = m !== 'skipped' && m !== 'not reached';
    lines.push(`| ${lane.lane} | ${m} | ${s} |${m !== s && counted ? ' **differs**' : ''}`);
    if (m !== s && counted) problems.push(`lane ${lane.lane}: single ${m}, split ${s}`);
  }

  lines.push('', '### Witness markers per log');
  const registered = [...(await requiredWitnesses(root, 'cli')), ...(await requiredWitnesses(root, 'viewer'))].map((w) => w.marker);
  const logNames = [...new Set([...mono.logs, ...SPLIT_LANE_JOBS.flatMap((job) => split[job].logs)])].sort();
  for (const name of logNames) {
    const read = (e) => (e.logs.includes(name) ? markers(readFileSync(join(e.dir, 'logs', name), 'utf8'), registered) : null);
    const a = read(mono);
    const owners = SPLIT_LANE_JOBS.filter((job) => split[job].logs.includes(name));
    const b = owners.length ? new Set(owners.flatMap((job) => [...read(split[job])])) : null;
    if (a === null || b === null) { lines.push(`- ${name}: only in ${a === null ? 'split' : 'single job'}`); problems.push(`log ${name} missing from the ${a === null ? 'single job' : 'split'}`); continue; }
    const extra = [...b].filter((x) => !a.has(x) && !(SPLIT_ONLY_MARKERS[name] ?? []).includes(x));
    const lost = [...a].filter((x) => !b.has(x));
    lines.push(`- ${name} (${owners.join(', ')}): ${a.size} single, ${b.size} split${lost.length ? `; **missing in split**: ${lost.join(', ')}` : ''}${extra.length ? `; **split only**: ${extra.join(', ')}` : ''}`);
    if (lost.length || extra.length) problems.push(`witness markers differ in ${name}`);
  }

  lines.push('', '### References (sha256, timing-free)', '', '| file | raw equal | timing-free equal |', '|---|---|---|');
  const native = split['na-native'];
  for (const rel of [...new Set([...Object.keys(mono.refs), ...Object.keys(native.refs)])].sort()) {
    if (!mono.refs[rel] && SPLIT_ONLY_REFS.includes(rel)) { lines.push(`| ${rel} | split only (by design) | - |`); continue; }
    if (!mono.refs[rel] || !native.refs[rel]) { lines.push(`| ${rel} | only in ${mono.refs[rel] ? 'single job' : 'split'} | - |`); problems.push(`reference ${rel} produced by one layout only`); continue; }
    const free = (e) => timingFreeHash(rel, readFileSync(join(e.dir, 'refs', rel)));
    const same = free(mono) === free(native);
    lines.push(`| ${rel} | ${mono.refs[rel] === native.refs[rel] ? 'yes' : 'no'} | ${same ? 'yes' : '**no**'} |`);
    if (!same) problems.push(`reference ${rel} differs`);
  }
  for (const job of ['na-browser', 'na-cli-parity']) {
    const bad = Object.entries(split[job].refs).filter(([rel, h]) => native.refs[rel] && native.refs[rel] !== h).map(([rel]) => rel);
    lines.push(`- transport to ${job}: ${bad.length ? `**altered** ${bad.join(', ')}` : `${Object.keys(split[job].refs).filter((r) => native.refs[r]).length} file(s) byte-equal to na-native's`}`);
    if (bad.length) problems.push(`references altered in transport to ${job}`);
  }

  const t = await timings(env, fetchImpl);
  lines.push('', '### Timings (minutes)');
  if (t.note) lines.push(`- ${t.note}`);
  else {
    lines.push(`- single job: ${t.monoMinutes?.toFixed(1) ?? '?'}; split critical path (first lane start to judge end): ${t.splitCriticalMinutes?.toFixed(1) ?? '?'}; split runner minutes: ${t.splitRunnerMinutes.toFixed(1)}`);
    for (const [id, x] of Object.entries(t.perJob)) lines.push(`  - ${id}: ${x.minutes.toFixed(1)} (started ${x.start})`);
  }
  lines.push('', problems.length ? `**MISMATCH** (${problems.length}):\n${problems.map((p) => `- ${p}`).join('\n')}` : '**MATCH**: same verdicts, lanes, witnesses and references.', '');
  return { match: problems.length === 0, problems, markdown: lines.join('\n'), timings: t };
}
