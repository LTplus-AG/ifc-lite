/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite rekey` (issue #4955): carry an external table keyed on one
 * revision's element keys across to the next revision, through a lineage
 * sidecar `ifc-lite diff --lineage-out` (or the viewer) wrote.
 *
 * The table is the user's own data — cost lines, inspection records, room
 * bookings — in CSV or a JSON array of objects. One column holds the old key.
 * Each row is answered by `rekeyByLineage`: it gets one or more new keys (a
 * split under `copy-to-all` duplicates the row), or it is orphaned, and the
 * orphans are written to their own file rather than dropped, because a row
 * that has nowhere to go is exactly the one a human needs to look at.
 * `--orphans` names that file; without it, a non-empty orphan set goes to
 * `<out>.orphans.<ext>` beside the output — never silently to nowhere.
 *
 * A key the lineage does not mention keeps its key (`unchanged`) unless the
 * lineage's `deleted` list names it: a lineage records changes, and a cost
 * table is mostly unchanged elements.
 *
 * Nothing about the lineage is re-derived or verified here beyond its own
 * structure: it was pinned to two model digests when it was written, and this
 * command has neither model. A caller who wants that check runs `diff
 * --lineage-in` against the files.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseLineageSidecar, rekeyByLineage, type RekeyPolicy } from '@ifc-lite/diff';
import { escapeCsvCell } from '@ifc-lite/export';
import { fatal, getFlag, hasFlag, printJson } from '../output.js';

const USAGE =
  'Usage: ifc-lite rekey <table.csv|table.json> --lineage <lineage.json> --out <file>\n' +
  '                      [--key-column <name>] [--policy copy-to-all|largest-share|orphan-on-split]\n' +
  '                      [--orphans <file>  (default: <out>.orphans.<ext> when any)] [--json]';

const POLICIES: ReadonlySet<string> = new Set<RekeyPolicy>(['copy-to-all', 'largest-share', 'orphan-on-split']);

type Row = Record<string, string>;

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): { header: string[]; rows: Row[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else field += c;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const header = records.shift() ?? [];
  const rows = records
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
  return { header, rows };
}

/** The one canonical escaper: RFC 4180 quoting plus the spreadsheet-formula guard. */
function csvField(value: string): string {
  return escapeCsvCell(value, { delimiter: ',' });
}

export function serializeCsv(header: string[], rows: Row[]): string {
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) lines.push(header.map((name) => csvField(row[name] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}

export interface RekeyOutcome {
  rows: Row[];
  orphans: Row[];
  counts: { input: number; rekeyed: number; duplicated: number; orphaned: number };
}

/**
 * Rekey rows in memory. A row whose key maps to k successors under the policy
 * is emitted k times, once per successor, with `lineage_relation` and
 * `lineage_from` columns recording where each copy came from.
 */
export function rekeyRows(rows: Row[], keyColumn: string, lineage: ReturnType<typeof parseLineageSidecar>, policy: RekeyPolicy): RekeyOutcome {
  const answers = new Map(
    rekeyByLineage(rows.map((row) => row[keyColumn] ?? ''), lineage, policy).map((r) => [r.key, r]),
  );
  const out: Row[] = [];
  const orphans: Row[] = [];
  let rekeyed = 0;
  let duplicated = 0;
  for (const row of rows) {
    const key = row[keyColumn] ?? '';
    const answer = answers.get(key);
    if (!answer || answer.orphan) {
      orphans.push({ ...row, lineage_relation: answer?.relation ?? '' });
      continue;
    }
    rekeyed++;
    if (answer.successors.length > 1) duplicated += answer.successors.length - 1;
    for (const successor of answer.successors) {
      out.push({ ...row, [keyColumn]: successor, lineage_relation: answer.relation ?? '', lineage_from: key });
    }
  }
  return {
    rows: out,
    orphans,
    counts: { input: rows.length, rekeyed, duplicated, orphaned: orphans.length },
  };
}

/** Flags that consume the following argument, so it is never mistaken for the
 *  positional table path. `--lineage lineage.json table.csv --out out.json`
 *  would otherwise have the naive `args.filter(a => !a.startsWith('-'))`
 *  idiom capture `lineage.json` as `positional[0]` and silently drop the real
 *  table path (same trap diff.ts's `VALUE_FLAGS` / mcp.ts's
 *  `MCP_VALUE_FLAGS` / ids.ts's `VALUE_FLAGS` fix elsewhere in this
 *  package). */
const VALUE_FLAGS = new Set(['--lineage', '--out', '--key-column', '--policy', '--orphans']);

function rekeyPositionals(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

export async function rekeyCommand(args: string[]): Promise<void> {
  const positional = rekeyPositionals(args);
  const tablePath = positional[0];
  const lineagePath = getFlag(args, '--lineage');
  const outPath = getFlag(args, '--out');
  if (!tablePath || !lineagePath || !outPath) fatal(USAGE);
  const keyColumn = getFlag(args, '--key-column') ?? 'GlobalId';
  const policyFlag = getFlag(args, '--policy') ?? 'copy-to-all';
  if (!POLICIES.has(policyFlag)) fatal(`--policy must be one of ${[...POLICIES].join(', ')}`);
  const policy = policyFlag as RekeyPolicy;
  const explicitOrphans = getFlag(args, '--orphans');

  let lineage;
  try {
    lineage = parseLineageSidecar(await readFile(lineagePath, 'utf-8'));
  } catch (error) {
    return fatal(`Cannot read lineage ${lineagePath}: ${(error as Error).message}`);
  }

  let text: string;
  try {
    text = await readFile(tablePath, 'utf-8');
  } catch (error) {
    return fatal(`Cannot read ${tablePath}: ${(error as Error).message}`);
  }
  const isJson = tablePath.toLowerCase().endsWith('.json');
  let header: string[];
  let rows: Row[];
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return fatal(`${tablePath} is not JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === 'object' && r !== null)) {
      return fatal(`${tablePath} must be a JSON array of objects`);
    }
    rows = (parsed as Record<string, unknown>[]).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])),
    );
    header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  } else {
    ({ header, rows } = parseCsv(text));
  }
  if (!header.includes(keyColumn)) {
    return fatal(`${tablePath} has no "${keyColumn}" column (columns: ${header.join(', ')}). Use --key-column.`);
  }

  const outcome = rekeyRows(rows, keyColumn, lineage, policy);
  // Orphans are never dropped: no --orphans and a non-empty set means a
  // default file beside the output.
  const orphansPath =
    explicitOrphans ?? (outcome.orphans.length > 0 ? outPath.replace(/(\.[^./\\]+)?$/, '.orphans$1') : undefined);
  const outHeader = [...header, 'lineage_relation', 'lineage_from'];
  await writeFile(
    outPath,
    isJson ? `${JSON.stringify(outcome.rows, null, 2)}\n` : serializeCsv(outHeader, outcome.rows),
    'utf-8',
  );
  if (orphansPath) {
    await writeFile(
      orphansPath,
      isJson ? `${JSON.stringify(outcome.orphans, null, 2)}\n` : serializeCsv([...header, 'lineage_relation'], outcome.orphans),
      'utf-8',
    );
  }

  if (hasFlag(args, '--json')) {
    printJson({ out: outPath, orphans: orphansPath ?? null, policy, keyColumn, counts: outcome.counts });
    return;
  }
  const { counts } = outcome;
  process.stdout.write(
    `\n  Rows in:     ${counts.input}\n  Rekeyed:     ${counts.rekeyed}` +
      (counts.duplicated ? ` (+${counts.duplicated} copies from splits)` : '') +
      `\n  Orphaned:    ${counts.orphaned}${orphansPath ? ` -> ${orphansPath}` : ''}\n  Written:     ${outPath}\n\n`,
  );
}
