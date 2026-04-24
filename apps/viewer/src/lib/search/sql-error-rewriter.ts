/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rewrite DuckDB / DuckDB-WASM error messages into UI-friendly copy,
 * with concrete hints when the error text is a known pattern.
 *
 * The strategy is conservative: if we match a known pattern, return a
 * structured RewrittenError with a title + hint + optional replacement
 * suggestion. Otherwise we fall back to the raw message so nothing is
 * hidden from power users. The UI renders the structured parts when
 * present and always includes a "Copy error" button for the raw text.
 */

export interface RewrittenError {
  /** Short human-facing title. */
  title: string;
  /** Longer hint / what-to-do-next sentence(s). Optional. */
  hint?: string;
  /** A single suggested SQL snippet the UI may offer as "Insert". */
  suggestion?: string;
  /** Original message from DuckDB, preserved for copy/diagnostics. */
  raw: string;
}

const SCHEMA_COLUMN_HINTS: Record<string, string> = {
  ifctype: 'type',
  ifc_type: 'type',
  globalid: 'global_id',
  expressid: 'express_id',
  pset: 'pset_name',
};

function normaliseColumnHint(column: string): string | null {
  const lower = column.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SCHEMA_COLUMN_HINTS[lower] ?? null;
}

const KNOWN_TABLES = [
  'entities',
  'properties',
  'quantities',
  'relationships',
  'walls',
  'doors',
  'windows',
  'slabs',
  'columns',
  'beams',
  'spaces',
  'entity_properties',
  'entity_quantities',
];

function suggestTable(bad: string): string | null {
  const lower = bad.toLowerCase();
  // Simple substring match — "entitie" → entities, "wall" → walls, etc.
  for (const known of KNOWN_TABLES) {
    if (known.includes(lower) || lower.includes(known.replace(/s$/, ''))) {
      return known;
    }
  }
  return null;
}

/**
 * Rewrite a raw DuckDB error. Always returns a RewrittenError — when
 * there's no pattern match, `title` mirrors the raw message (trimmed)
 * and `hint` / `suggestion` are omitted.
 */
export function rewriteSqlError(raw: unknown): RewrittenError {
  const text = typeof raw === 'string'
    ? raw
    : raw instanceof Error
      ? raw.message
      : String(raw);

  // Unknown column. DuckDB typically says:
  //   Binder Error: Referenced column "ifctype" not found in FROM clause!
  const columnMatch = text.match(/Referenced column\s+"([^"]+)"\s+not found/i);
  if (columnMatch) {
    const bad = columnMatch[1];
    const hint = normaliseColumnHint(bad);
    return {
      title: `Column "${bad}" does not exist`,
      hint: hint
        ? `Did you mean "${hint}"? The entities table uses snake_case (global_id, express_id, object_type).`
        : 'Check the schema browser on the left for the actual column names. The entities table uses snake_case.',
      suggestion: hint ?? undefined,
      raw: text,
    };
  }

  // Unknown table. DuckDB typically says:
  //   Catalog Error: Table with name "entity" does not exist!
  const tableMatch = text.match(/Table\s+with\s+name\s+"([^"]+)"\s+does\s+not\s+exist/i);
  if (tableMatch) {
    const bad = tableMatch[1];
    const suggestion = suggestTable(bad);
    return {
      title: `Table "${bad}" does not exist`,
      hint: suggestion
        ? `Did you mean "${suggestion}"? Known tables: ${KNOWN_TABLES.slice(0, 4).join(', ')}, … (see schema browser).`
        : `Known tables: ${KNOWN_TABLES.slice(0, 4).join(', ')}, … (see schema browser).`,
      suggestion: suggestion ?? undefined,
      raw: text,
    };
  }

  // Parser errors — show a useful pointer to where parsing failed.
  const syntaxMatch = text.match(/(Parser|Syntax)\s+Error/i);
  if (syntaxMatch) {
    return {
      title: 'SQL syntax error',
      hint: 'Check for a missing comma, unterminated string, or an unbalanced parenthesis near the reported position.',
      raw: text,
    };
  }

  // Transaction / conversion errors — surface the raw but add a hint.
  if (/Conversion\s+Error/i.test(text)) {
    return {
      title: 'Value conversion error',
      hint: 'A value did not fit the expected type. Check boolean comparisons (use TRUE / FALSE not 1 / 0) and numeric casts.',
      raw: text,
    };
  }

  // "DuckDB not initialized" — happens when the SQL tab runs before
  // init has finished. The UI should gate on `ready` but surface a
  // readable error anyway.
  if (/not\s+initialized/i.test(text)) {
    return {
      title: 'SQL engine is still warming up',
      hint: 'DuckDB is registering tables from the active model. Try again in a second.',
      raw: text,
    };
  }

  // "Failed to initialize DuckDB" — the optional @duckdb/duckdb-wasm
  // package isn't installed or couldn't load.
  if (/Failed\s+to\s+initialize\s+DuckDB/i.test(text)) {
    return {
      title: 'DuckDB is not available',
      hint: 'The SQL tab needs the optional @duckdb/duckdb-wasm package. Install it with `pnpm add @duckdb/duckdb-wasm` and reload.',
      raw: text,
    };
  }

  // Fallback — show the trimmed raw message as the title.
  const trimmed = text.trim().replace(/\n+/g, ' ');
  return {
    title: trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed,
    raw: text,
  };
}

/** Exposed for tests only. */
export const __internal = { KNOWN_TABLES, normaliseColumnHint, suggestTable };
