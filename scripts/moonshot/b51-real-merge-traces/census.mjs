/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 step 2: the corpus census.
 *
 * Split out of run.mjs to hold every module under the house size rule. It
 * answers one question -- what trace material exists, and does it clear the
 * bar registered in prereg.mjs -- by reading the tree, never by assuming
 * anything about a deployment.
 *
 * Nothing here writes. run.mjs owns the only write path, so every count this
 * file produces still passes the identifier guard before it is stored.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ADMISSIBILITY, satisfies } from './prereg.mjs';


const collabSrc = (repoRoot) => path.join(repoRoot, 'packages/collab-server/src');

/**
 * Read the audit-log record type out of the source and decide, by inspection
 * rather than by assumption, how many of the battery's four op kinds it can
 * express.
 *
 * The four kinds are attr-set, geometry-replace, entity-add and entity-remove.
 * Expressing any of them needs a field naming a TARGET (which entity, which
 * property set, which mesh) and a field carrying a VALUE. The check is
 * therefore: enumerate the record's declared fields, and count how many of the
 * four could be reconstructed from them.
 */
export function auditRecordCapability(repoRoot) {
  const file = path.join(collabSrc(repoRoot), 'audit-log.ts');
  if (!existsSync(file)) return { found: false, fields: [], opTypes: [], expresses: 0 };
  const text = readFileSync(file, 'utf-8');

  const entityBlock = /export interface AuditEntry \{([\s\S]*?)\n\}/.exec(text);
  const fields = entityBlock
    ? [...entityBlock[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort()
    : [];

  const opTypeBlock = /export type AuditOpType =([\s\S]*?);/.exec(text);
  const opTypes = opTypeBlock ? [...opTypeBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort() : [];

  // A target field would name an entity, a property or a mesh. A value field
  // would carry the written value. Neither vocabulary appears.
  const TARGET_WORDS = ['entity', 'element', 'node', 'pset', 'property', 'mesh', 'path', 'target', 'attribute'];
  const VALUE_WORDS = ['value', 'payload', 'attributes', 'update', 'delta', 'body'];
  const hasTarget = fields.some((f) => TARGET_WORDS.some((w) => f.toLowerCase().includes(w)));
  const hasValue = fields.some((f) => VALUE_WORDS.some((w) => f.toLowerCase().includes(w)));

  return {
    found: true,
    fields,
    opTypes,
    hasTargetField: hasTarget,
    hasValueField: hasValue,
    // Without both, none of the four kinds is reconstructible.
    expresses: hasTarget && hasValue ? 4 : 0,
  };
}

/**
 * Is the audit sink reachable in the shipped deployment at all?
 *
 * The binary entry point is bin.ts and it is what the Dockerfile runs. If it
 * never constructs a sink, the room manager falls back to the drop-everything
 * default and the deployment records nothing, whatever the record type could
 * have carried. That is a stronger fact than any environment listing, because
 * it holds for every deployment of this binary rather than for one of them.
 */
export function auditSinkWiring(repoRoot) {
  const src = collabSrc(repoRoot);
  const bin = path.join(src, 'bin.ts');
  const roomManager = path.join(src, 'room-manager.ts');
  const binText = existsSync(bin) ? readFileSync(bin, 'utf-8') : '';
  const rmText = existsSync(roomManager) ? readFileSync(roomManager, 'utf-8') : '';

  // Any env-var knob that could switch a sink on without a code change.
  const srcFiles = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith('.ts')) : [];
  let envKnobs = 0;
  for (const f of srcFiles) {
    const t = readFileSync(path.join(src, f), 'utf-8');
    envKnobs += [...t.matchAll(/process\.env\.COLLAB_[A-Z_]*AUDIT[A-Z_]*/g)].length;
  }

  return {
    binaryEntryFile: 'packages/collab-server/src/bin.ts',
    binaryEntryConstructsSink: /auditSink/.test(binText),
    defaultIsDropEverything: /this\.auditSink = opts\.auditSink \?\? noopAuditSink/.test(rmText),
    environmentKnobsThatCouldEnableIt: envKnobs,
    sourceFilesScanned: srcFiles.length,
  };
}

/** Frame-count a FilePersistence room log without decoding it. */
function inspectRoomLog(abs) {
  const buf = readFileSync(abs);
  let off = 0;
  let frames = 0;
  let ok = true;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    if (len === 0 || off + len > buf.length) {
      ok = false;
      break;
    }
    off += len;
    frames += 1;
  }
  return { bytes: buf.length, frames, framingIntact: ok && off === buf.length };
}

/**
 * Room ids this repository's OWN example applications open, read out of their
 * sources rather than listed here.
 *
 * Criterion a5 asks for sessions from deployments that are not this program. A
 * room log whose id is one the repo's own demo scripts hard-code is by
 * definition this program talking to itself, and counting it as external
 * validity would be the exact failure the admissibility bar exists to prevent.
 * FilePersistence sanitizes the id into the filename, historically by replacing
 * every character outside [A-Za-z0-9._-] with an underscore, so both the
 * current and the legacy encodings are matched.
 */
function repoDemoRoomFilenames(repoRoot) {
  const sources = [
    'examples/collab-demo/src/main.ts',
    'examples/threejs-collab/src/main.ts',
  ];
  const names = new Set();
  for (const rel of sources) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    for (const m of readFileSync(abs, 'utf-8').matchAll(/ROOM_ID\s*=\s*'([^']+)'/g)) {
      const id = m[1];
      names.add(`${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
      names.add(`${encodeURIComponent(id)}.log`);
    }
  }
  return names;
}

/**
 * How many distinct origins a supplied trace root declares.
 *
 * Criterion a5 counts DEPLOYMENTS OR TEAMS, and a directory of room logs
 * carries no field saying which deployment wrote which log -- a room id is a
 * project path, not a tenant. So the count comes from metadata the operator
 * states explicitly: an `origins.txt` beside the traces, one label per line.
 * The labels are operator-supplied material from outside this repository and
 * are therefore COUNTED AND DISCARDED -- never returned, never stored, never
 * handed to an artifact. Only the cardinality leaves this function.
 *
 * A root with no such file is worth at most ONE origin, which is the honest
 * reading of "somebody gave me a directory": one directory, one provenance
 * story, whatever number of rooms it happens to hold.
 */
function declaredOriginCount(root) {
  for (const name of ['origins.txt', 'ORIGINS']) {
    const abs = path.join(root, name);
    if (!existsSync(abs)) continue;
    const labels = new Set(
      readFileSync(abs, 'utf-8')
        .split('\n')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && !s.startsWith('#')),
    );
    return labels.size;
  }
  return null;
}

function censusTraceRoots(repoRoot, requested) {
  const roots = [...requested];
  // The in-tree default is this repository's own server writing its own data
  // directory. It is counted for volume, never for independence: see
  // `contributesIndependentOrigins` below.
  const suppliedCount = requested.length;
  if (roots.length === 0) roots.push(path.join(repoRoot, '.collab-data'));
  const demoNames = repoDemoRoomFilenames(repoRoot);
  const out = [];
  for (const [i, root] of roots.entries()) {
    const suppliedOnCommandLine = i < suppliedCount;
    if (!existsSync(root)) {
      out.push({
        rootExists: false,
        roomLogs: 0,
        totalFrames: 0,
        totalBytes: 0,
        rotatedAuditFiles: 0,
        suppliedOnCommandLine,
        roomLogsNotOpenedByThisRepositoryOwnDemos: 0,
        originsDeclaredByOperator: 0,
        contributesIndependentOrigins: 0,
      });
      continue;
    }
    const entries = readdirSync(root).filter((f) => statSync(path.join(root, f)).isFile());
    const logs = entries.filter((f) => f.endsWith('.log'));
    let totalFrames = 0;
    let totalBytes = 0;
    let intact = 0;
    for (const f of logs) {
      const r = inspectRoomLog(path.join(root, f));
      totalFrames += r.frames;
      totalBytes += r.bytes;
      if (r.framingIntact) intact += 1;
    }
    // See repoDemoRoomFilenames: a log this program's own demo opened is not
    // an independent origin, whatever else it contains.
    const demoLogs = logs.filter((f) => demoNames.has(f)).length;
    const nonDemoLogs = logs.length - demoLogs;
    const declared = declaredOriginCount(root);
    // A root contributes independence only if it was supplied from outside the
    // tree AND holds at least one log this repository's own demos did not open.
    // Given that, it is worth the number of origins the operator declared, or
    // one if the operator declared none.
    const contributes = suppliedOnCommandLine && nonDemoLogs > 0 ? (declared ?? 1) : 0;
    out.push({
      rootExists: true,
      roomLogs: logs.length,
      roomLogsWithIntactFraming: intact,
      roomLogsOpenedByThisRepositoryOwnDemos: demoLogs,
      roomLogsNotOpenedByThisRepositoryOwnDemos: nonDemoLogs,
      suppliedOnCommandLine,
      originsDeclaredByOperator: declared ?? 0,
      contributesIndependentOrigins: contributes,
      totalFrames,
      totalBytes,
      // A JSONL audit log would be a `.jsonl`, or a rotated `.log.<stamp>`.
      rotatedAuditFiles: entries.filter((f) => /\.log\.\d{4}-/.test(f)).length,
      jsonlFiles: entries.filter((f) => f.endsWith('.jsonl') || f.endsWith('.ndjson')).length,
    });
  }
  return out;
}

/** Session traces committed to this repository, by extension. */
function committedTraceFiles(repoRoot) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth - 1);
      else if (/\.(jsonl|ndjson)$/.test(e.name)) hits.push(abs);
    }
  };
  walk(path.join(repoRoot, 'packages'), 3);
  walk(path.join(repoRoot, 'tests'), 3);
  walk(path.join(repoRoot, 'scripts'), 3);
  return hits.length;
}

export function buildCensus({ repoRoot, traceRoots }) {
  const capability = auditRecordCapability(repoRoot);
  const wiring = auditSinkWiring(repoRoot);
  const roots = censusTraceRoots(repoRoot, traceRoots);

  const roomLogs = roots.reduce((a, r) => a + (r.roomLogs ?? 0), 0);
  const demoRoomLogs = roots.reduce((a, r) => a + (r.roomLogsOpenedByThisRepositoryOwnDemos ?? 0), 0);
  const externalRoots = traceRoots.length;
  const totalFrames = roots.reduce((a, r) => a + (r.totalFrames ?? 0), 0);
  const jsonlAuditFiles = roots.reduce((a, r) => a + (r.jsonlFiles ?? 0), 0) +
    roots.reduce((a, r) => a + (r.rotatedAuditFiles ?? 0), 0);

  // Observed corpus, expressed in the bar's own metrics. A room log is a
  // persisted CRDT document, not a session recording: it carries no session
  // boundary and no editor roster, so the honest reading of `distinctSessions`
  // is the number of rooms and of `multiEditorSessions` is zero until an audit
  // log establishes who was connected when. Both are recorded as measured,
  // which is what makes the bar bite.
  const metrics = {
    distinctSessions: roomLogs,
    multiEditorSessions: 0,
    opKindsCovered: 0,
    sessionsWithHosting: 0,
    // a5 counts DEPLOYMENTS, so it is a sum over roots and not a boolean. The
    // previous form collapsed every non-demo corpus to 1 and therefore made the
    // registered bar of 3 unreachable by any input, which is a broken meter,
    // not a strict one. The bar is untouched; only the count is fixed.
    independentOrigins: roots.reduce((a, r) => a + (r.contributesIndependentOrigins ?? 0), 0),
    recordTypeExpressesOpKinds: capability.expresses,
  };

  const criteria = ADMISSIBILITY.criteria.map((c) => ({
    id: c.id,
    label: c.label,
    metric: c.bar.metric,
    required: c.bar.value,
    comparator: c.bar.comparator,
    observed: metrics[c.bar.metric],
    cleared: satisfies(c.bar.comparator, metrics[c.bar.metric], c.bar.value),
  }));

  return {
    bet: 'B5.1',
    auditRecordType: {
      declaredFields: capability.fields,
      declaredOpTypes: capability.opTypes,
      namesATarget: capability.hasTargetField,
      carriesAValue: capability.hasValueField,
      expressesBatteryOpKinds: capability.expresses,
    },
    auditSinkWiring: wiring,
    traceRoots: roots,
    // A root supplied on the command line lives outside the repository, so the
    // counts above are NOT reproducible from a clean checkout. Recorded next to
    // them so no reader has to work that out.
    traceRootsSuppliedOnCommandLine: externalRoots,
    reproducibleFromTree: externalRoots === 0,
    roomLogsOpenedByThisRepositoryOwnDemos: demoRoomLogs,
    committedSessionTraceFiles: committedTraceFiles(repoRoot),
    jsonlAuditFilesFound: jsonlAuditFiles,
    totalPersistedFrames: totalFrames,
    metrics,
    criteria,
    criteriaCleared: criteria.filter((c) => c.cleared).length,
    criteriaTotal: criteria.length,
    admissible: criteria.every((c) => c.cleared),
  };
}

