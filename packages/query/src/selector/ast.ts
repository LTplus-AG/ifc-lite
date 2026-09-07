/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AST for the IfcOpenShell selector (filter) syntax.
 *
 * The AST is the seam: {@link parseSelector} understands the whole grammar,
 * and each surface (the viewer's rule builder today, the CLI/MCP/SDK query
 * descriptor next) is an adapter from this tree onto its own representation.
 * The parser therefore accepts constructs no adapter can evaluate yet — an
 * adapter reports those back rather than dropping them, which is why every
 * node carries {@link SelectorFilterBase.text}, the exact source substring the
 * user typed.
 */

/** Comparison operators the grammar defines. `*=` is "contains". */
export type SelectorOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '*=' | '!*=';

/** A literal name or value: a plain string, or a `/…/` regular expression. */
export type SelectorText =
  | { kind: 'string'; text: string }
  | { kind: 'regex'; source: string };

/** A comparison right-hand side. Bare `NULL` (any case) is the null literal. */
export type SelectorValue = SelectorText | { kind: 'null' };

/** Keyword filters that compare one derived attribute of an element. */
export type SelectorKeywordKind =
  | 'type'
  | 'material'
  | 'classification'
  | 'location'
  | 'parent';

interface SelectorFilterBase {
  /** The exact source substring this filter was parsed from. */
  text: string;
}

/** `IfcWall` / `! IfcWall` — the class and all its subclasses. */
interface SelectorClassFilter extends SelectorFilterBase {
  kind: 'class';
  name: string;
  negate: boolean;
}

/** `325Q7Fhnf67OZC$$r43uzK` / `! 325Q7Fhnf67OZC$$r43uzK` — one element. */
interface SelectorGlobalIdFilter extends SelectorFilterBase {
  kind: 'globalId';
  id: string;
  negate: boolean;
}

/** `Name=Foo` — an IFC attribute of the element itself. */
interface SelectorAttributeFilter extends SelectorFilterBase {
  kind: 'attribute';
  name: string;
  op: SelectorOp;
  value: SelectorValue;
}

/** `Pset_WallCommon.FireRating=2HR` — a property in a property set. */
interface SelectorPropertyFilter extends SelectorFilterBase {
  kind: 'property';
  pset: SelectorText;
  prop: SelectorText;
  op: SelectorOp;
  value: SelectorValue;
}

/** `type=WT01`, `material=concrete`, `location="Level 3"`, … */
interface SelectorKeywordFilter extends SelectorFilterBase {
  kind: SelectorKeywordKind;
  op: SelectorOp;
  value: SelectorValue;
}

/** `query:types.count=0` — a value-query key path. */
interface SelectorQueryFilter extends SelectorFilterBase {
  kind: 'query';
  keys: string;
  op: SelectorOp;
  value: SelectorValue;
}

/**
 * Every filter the grammar can express. The member interfaces stay
 * module-internal: a consumer narrows on `filter.kind` off this union rather
 * than naming one, and an exported type nothing consumes is semver liability
 * with no reader.
 */
export type SelectorFilter =
  | SelectorClassFilter
  | SelectorGlobalIdFilter
  | SelectorAttributeFilter
  | SelectorPropertyFilter
  | SelectorKeywordFilter
  | SelectorQueryFilter;

/** Filters chained with `,`. They narrow left to right (AND). */
export interface SelectorGroup {
  filters: SelectorFilter[];
}

/** Groups joined with `+`. Their results are unioned. */
export interface SelectorQuery {
  groups: SelectorGroup[];
}

export interface SelectorParseError {
  message: string;
  /** 0-based character offset into the input where the problem starts. */
  offset: number;
}

export type SelectorParseResult =
  | { ok: true; query: SelectorQuery }
  | { ok: false; error: SelectorParseError };
