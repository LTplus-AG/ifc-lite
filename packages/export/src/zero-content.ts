/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Did this export actually carry any content?" for the two Rust-backed
 * non-mesh formats — the JSON-LD and STEP twins of `countObjVertices` (OBJ)
 * and `countGlbMeshes` (GLB).
 *
 * Both writers always return a syntactically valid, non-zero-byte document
 * even when every entity is filtered out: JSON-LD still carries its
 * `@context` around an empty `@graph`, and the STEP writer still regenerates
 * the ISO-10303-21 header around an empty `DATA;` section. So a byte-length
 * check cannot tell an empty export from a real one, exactly as it cannot for
 * a header-only OBJ. Node count and entity count are the content signals.
 */

/**
 * Count the `@graph` nodes in an IFC-Lite-generated JSON-LD export. Zero means
 * the document describes no entities.
 *
 * The graph is parsed rather than pattern-matched: `"@id"` also appears on
 * nested property-set and quantity-set objects, so counting occurrences would
 * over-report and let an entity-free document look populated.
 */
export function countJsonldNodes(jsonld: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonld));
  } catch {
    // A malformed / non-UTF-8 / non-JSON buffer describes no entities. Return
    // 0 so callers treat it as an empty export (and fail loud) rather than
    // crashing on the decode with an opaque stack trace.
    return 0;
  }
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const graph = (parsed as { '@graph'?: unknown })['@graph'];
  return Array.isArray(graph) ? graph.length : 0;
}

/**
 * Count the entity instances (`#123=...`) in a STEP/IFC export. Zero means the
 * `DATA;` section is empty — a header-only file that round-trips to nothing.
 *
 * The Rust STEP writer emits one instance per line, so an anchored per-line
 * match counts instances without a full STEP parse. A `#123` appearing as a
 * reference inside another instance's attribute list is never at the start of
 * a line, so it cannot inflate the count.
 */
export function countStepEntities(step: Uint8Array): number {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(step);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^#\d+\s*=/.test(line)) count++;
  }
  return count;
}
