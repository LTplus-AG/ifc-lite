/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Startup-control-only pinned Cargo CacheData surgery, not a benchmark cache.
import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const MAX_BYTES = 2 * 1024 * 1024, MAX_DEPTH = 16, MAX_NODES = 8192, MAX_OUTPUTS = 256;
const MAX_TEXT = 131072, U64_MAX = 18446744073709551615n;
const hash = value => createHash('sha256').update(value).digest('hex');
const refuse = message => { throw new Error(`selective Cargo query cache refused: ${message}`); };

// Validate structure while retaining spans; never round-trip opaque u64s via Number.
// Each character is visited a bounded number of times, with bounded recursion/work.
function parseCache(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) refuse('cache byte bound');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse('UTF8 BOM');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let at = 0, nodes = 0;
  const space = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') {
        const raw = text.slice(start, at), value = JSON.parse(raw);
        if (Buffer.byteLength(value, 'utf8') > MAX_TEXT) refuse('string byte bound');
        return { type: 'string', value, start, end: at };
      }
    }
    refuse('unterminated string');
  }
  function value(depth) {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) refuse('depth/work bound');
    space(); const start = at;
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; space(); const members = [], keys = new Set(); let commaBefore = null;
      while (text[at] !== '}') {
        if (text[at] !== '"') refuse('object key');
        const key = string();
        if (keys.has(key.value)) refuse('duplicate object key');
        keys.add(key.value); space(); if (text[at++] !== ':') refuse('object colon');
        const item = value(depth + 1); space();
        const commaAfter = text[at] === ',' ? at : null;
        members.push({ key: key.value, start: key.start, end: item.end, value: item, commaBefore, commaAfter });
        if (commaAfter === null) break;
        commaBefore = at++; space(); if (text[at] === '}') refuse('trailing object comma');
      }
      if (text[at++] !== '}') refuse('object closing brace');
      return { type: 'object', start, end: at, members };
    }
    if (text[at] === '[') {
      at++; space(); const items = [];
      while (text[at] !== ']') {
        items.push(value(depth + 1)); space();
        if (text[at] !== ',') break;
        at++; space(); if (text[at] === ']') refuse('trailing array comma');
      }
      if (text[at++] !== ']') refuse('array closing bracket');
      return { type: 'array', start, end: at, items };
    }
    while (at < text.length && !/[\x20\t\r\n,}\]]/.test(text[at])) at++;
    const raw = text.slice(start, at);
    if (raw === 'null') return { type: 'null', start, end: at };
    if (raw === 'true' || raw === 'false') return { type: 'boolean', value: raw === 'true', start, end: at };
    if (raw.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) refuse('invalid scalar');
    return { type: 'number', raw, start, end: at };
  }
  const root = value(0); space(); if (at !== text.length) refuse('trailing data');
  return { root, text, nodes };
}
function fields(node, names) {
  if (node.type !== 'object' || node.members.length !== names.length
    || node.members.some(member => !names.includes(member.key))) refuse('unknown/missing schema fields');
  return Object.fromEntries(node.members.map(member => [member.key, member.value]));
}
function u64(raw) {
  if (typeof raw !== 'string' || raw.length > 20 || !/^(?:0|[1-9]\d*)$/.test(raw) || BigInt(raw) > U64_MAX) refuse('u64 format/range');
}
function outputRecord(node) {
  const f = fields(node, ['success', 'status', 'code', 'stdout', 'stderr']);
  if (f.success.type !== 'boolean' || ['status', 'stdout', 'stderr'].some(key => f[key].type !== 'string')) refuse('output schema');
  if (f.code.type !== 'null' && (f.code.type !== 'number' || !/^-?(?:0|[1-9]\d*)$/.test(f.code.raw)
    || f.code.raw.length > 11 || BigInt(f.code.raw) < -2147483648n || BigInt(f.code.raw) > 2147483647n)) refuse('exit code');
  return { success: f.success.value, status: f.status.value,
    code: f.code.type === 'null' ? null : Number(f.code.raw), stdout: f.stdout.value, stderr: f.stderr.value };
}
function schema(parsed) {
  const f = fields(parsed.root, ['rustc_fingerprint', 'outputs', 'successes']);
  if (f.rustc_fingerprint.type !== 'number') refuse('fingerprint type');
  u64(f.rustc_fingerprint.raw);
  if (f.outputs.type !== 'object' || f.outputs.members.length > MAX_OUTPUTS || f.successes.type !== 'object') refuse('cache collection bound');
  for (const member of f.outputs.members) { u64(member.key); outputRecord(member.value); }
  for (const member of f.successes.members) { u64(member.key); if (member.value.type !== 'boolean') refuse('successes schema'); }
  return f;
}
function expectedResult(observed) {
  if (!observed || observed.status !== 0 || observed.signal !== null || observed.error
    || typeof observed.stdout !== 'string' || typeof observed.stderr !== 'string'
    || Buffer.byteLength(observed.stdout, 'utf8') > MAX_TEXT || Buffer.byteLength(observed.stderr, 'utf8') > MAX_TEXT) refuse('actual direct query result');
  return { success: true, status: '', code: 0, stdout: observed.stdout, stderr: observed.stderr };
}
const equalOutput = (left, right) => ['success', 'status', 'code', 'stdout', 'stderr'].every(key => left[key] === right[key]);

// Expected outputs come from direct pinned compiler probes in the owned control.
// No caller-selected numeric key or key-hash reconstruction is accepted.
export function invalidateTargetQueryCache(before, actualTarget, actualVersion) {
  const parsed = parseCache(before), original = schema(parsed);
  const targetResult = expectedResult(actualTarget), versionResult = expectedResult(actualVersion);
  if (equalOutput(targetResult, versionResult)) refuse('target/version output collision');
  const matching = expected => original.outputs.members.filter(member => equalOutput(outputRecord(member.value), expected));
  const targets = matching(targetResult), versions = matching(versionResult);
  if (targets.length !== 1 || versions.length !== 1 || targets[0].key === versions[0].key) refuse('missing/ambiguous complete query output');
  const target = targets[0], version = versions[0];
  const start = target.commaAfter !== null ? target.start : target.commaBefore;
  const end = target.commaAfter !== null ? target.commaAfter + 1 : target.end;
  if (start === null) refuse('target without preserved version member');
  const startByte = Buffer.byteLength(parsed.text.slice(0, start), 'utf8');
  const endByte = Buffer.byteLength(parsed.text.slice(0, end), 'utf8');
  const after = Buffer.concat([before.subarray(0, startByte), before.subarray(endByte)]);
  const changed = parseCache(after), remaining = schema(changed);
  if (remaining.rustc_fingerprint.raw !== original.rustc_fingerprint.raw
    || remaining.outputs.members.length !== original.outputs.members.length - 1
    || remaining.outputs.members.some(member => member.key === target.key)) refuse('changed cache invariants');
  for (const member of remaining.outputs.members) {
    const previous = original.outputs.members.find(item => item.key === member.key);
    if (!previous || changed.text.slice(member.start, member.end) !== parsed.text.slice(previous.start, previous.end)) refuse('another output changed');
  }
  if (changed.text.slice(remaining.successes.start, remaining.successes.end)
    !== parsed.text.slice(original.successes.start, original.successes.end)) refuse('successes changed');
  return { after, receipt: { scope: 'OWN startup cache target-entry invalidation; not production',
    beforeSha256: hash(before), afterSha256: hash(after), targetKey: target.key, versionKey: version.key,
    fingerprintLiteral: original.rustc_fingerprint.raw, removedStartByte: startByte,
    removedEndByte: endByte, removedSha256: hash(before.subarray(startByte, endByte)),
    preservedPrefixSha256: hash(before.subarray(0, startByte)), preservedSuffixSha256: hash(before.subarray(endByte)),
    beforeBytes: before.length, afterBytes: after.length, originalOutputs: original.outputs.members.length,
    preservedOutputs: remaining.outputs.members.length, versionRetained: true,
    byteExactOutsideRemovedSpan: true, originalParseNodes: parsed.nodes, finalParseNodes: changed.nodes,
    preservedVersionRecordSha256: hash(parsed.text.slice(version.start, version.end)) } };
}

// Finite owned-sandbox file witnesses, not a machine census or syscall trace.
// Every FD read is bounded by its frozen size; changing files/symlinks refuse.
export function ownedQueryFileCensus(directory) {
  if (realpathSync(directory) !== directory) refuse('owned census canonical root');
  const entries = []; let bytes = 0, visits = 0;
  function visit(path, relative, depth) {
    if (depth > 16 || ++visits > 512) refuse('owned file census depth/work');
    const before = lstatSync(path);
    if (before.isSymbolicLink()) refuse('owned census symlink');
    if (before.isDirectory()) {
      entries.push({ path: relative, kind: 'directory', dev: String(before.dev), ino: String(before.ino) });
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name, depth + 1);
      return;
    }
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > 33554432) refuse('owned census file bound');
    bytes += before.size; if (bytes > 67108864) refuse('owned census total byte bound');
    const fd = openSync(path, 'r');
    try {
      const pinned = fstatSync(fd);
      if (!pinned.isFile() || pinned.dev !== before.dev || pinned.ino !== before.ino || pinned.size !== before.size) refuse('owned census file changed at open');
      const digest = createHash('sha256'), chunk = Buffer.alloc(65536); let offset = 0;
      while (offset < before.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (count === 0) refuse('owned census truncated file');
        digest.update(chunk.subarray(0, count)); offset += count;
      }
      const extra = readSync(fd, chunk, 0, 1, before.size), after = fstatSync(fd);
      if (extra !== 0 || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeMs !== before.mtimeMs) refuse('owned census file changed while reading');
      entries.push({ path: relative, kind: 'file', dev: String(before.dev), ino: String(before.ino),
        bytes: before.size, sha256: digest.digest('hex') });
    } finally { closeSync(fd); }
  }
  visit(directory, '', 0);
  return { scope: 'Owned regular-file/directory state before/after direct query; no transient-write or syscall claim',
    entries, bytes, visits, bounds: { entries: 512, depth: 16, fileBytes: 33554432, totalBytes: 67108864 } };
}
