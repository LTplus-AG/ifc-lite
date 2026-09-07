/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recursive-descent parser for the IfcOpenShell selector syntax.
 *
 *     query  := group ("+" group)*        groups are unioned
 *     group  := filter ("," filter)*      filters narrow left to right
 *     filter := "!"? (class | globalId)
 *             | word ("." name)? op value
 *             | (string | regex) "." name op value
 *
 * The parser is deliberately more capable than any single adapter: it accepts
 * every construct the page documents, so an adapter can name what it cannot
 * evaluate instead of silently matching nothing — the defect behind #4091.
 *
 * See {@link tokenizeSelector} for the lexical rules and where they are ifc-lite's
 * reading rather than the page's words.
 */

import type {
  SelectorFilter,
  SelectorGroup,
  SelectorKeywordKind,
  SelectorOp,
  SelectorParseError,
  SelectorParseResult,
  SelectorText,
  SelectorValue,
} from './ast.js';
import { tokenizeSelector, type Token } from './tokenize.js';

const KEYWORDS = new Map<string, SelectorKeywordKind>([
  ['type', 'type'],
  ['material', 'material'],
  ['classification', 'classification'],
  ['location', 'location'],
  ['parent', 'parent'],
]);

const QUERY_PREFIX = 'query:';
const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;

class ParseFailure extends Error {
  constructor(readonly error: SelectorParseError) {
    super(error.message);
    this.name = 'ParseFailure';
  }
}

export function parseSelector(text: string): SelectorParseResult {
  const lexed = tokenizeSelector(text);
  if (!lexed.ok) return { ok: false, error: lexed.error };
  if (lexed.tokens.length === 0) {
    return {
      ok: false,
      error: { message: 'empty selector: type a class name such as IfcWall', offset: 0 },
    };
  }
  try {
    return { ok: true, query: { groups: new Parser(text, lexed.tokens).parseQuery() } };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, error: err.error };
    throw err;
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly source: string, private readonly tokens: Token[]) {}

  parseQuery(): SelectorGroup[] {
    const groups: SelectorGroup[] = [this.parseGroup()];
    while (this.peek()?.kind === 'plus') {
      this.advance();
      groups.push(this.parseGroup());
    }
    const trailing = this.peek();
    if (trailing) this.fail(`unexpected "${trailing.value}"`, trailing.start);
    return groups;
  }

  private parseGroup(): SelectorGroup {
    const filters: SelectorFilter[] = [this.parseFilter()];
    while (this.peek()?.kind === 'comma') {
      this.advance();
      filters.push(this.parseFilter());
    }
    return { filters };
  }

  private parseFilter(): SelectorFilter {
    const first = this.require('expected a filter');
    let negate = false;
    let head = first;
    if (first.kind === 'bang') {
      negate = true;
      this.advance();
      head = this.require('expected a class name or GlobalId after "!"');
    }

    if (head.kind !== 'word' && head.kind !== 'string' && head.kind !== 'regex') {
      this.fail(`unexpected "${head.value}"`, head.start);
    }
    this.advance();

    const after = this.peek();

    if (after?.kind === 'dot') {
      if (negate) this.failNegate(first);
      this.advance();
      return this.finishProperty(first, nameOf(head));
    }

    if (after?.kind === 'op') {
      if (negate) this.failNegate(first);
      if (head.kind !== 'word') {
        this.fail(
          'a quoted name or regular expression is only valid as a property-set or property name, e.g. /Pset_.*Common/.FireRating=2HR',
          head.start,
        );
      }
      return this.finishKeyed(first, head);
    }

    return this.finishBare(first, head, negate);
  }

  /** `<pset> . <prop> <op> <value>`, the pset already consumed. */
  private finishProperty(first: Token, pset: SelectorText): SelectorFilter {
    const propTok = this.require('expected a property name after "."');
    if (propTok.kind !== 'word' && propTok.kind !== 'string' && propTok.kind !== 'regex') {
      this.fail(`expected a property name after "." but found "${propTok.value}"`, propTok.start);
    }
    this.advance();
    const op = this.requireOp();
    const value = this.requireValue(op);
    return {
      kind: 'property',
      pset,
      prop: nameOf(propTok),
      op: op.value as SelectorOp,
      value,
      text: this.spanFrom(first),
    };
  }

  /** `<word> <op> <value>` — property with an inline dot, keyword, query or attribute. */
  private finishKeyed(first: Token, head: Token): SelectorFilter {
    const key = head.value;
    const op = this.requireOp();
    const value = this.requireValue(op);
    const text = this.spanFrom(first);

    if (key.toLowerCase().startsWith(QUERY_PREFIX)) {
      const keys = key.slice(QUERY_PREFIX.length);
      if (keys.length === 0) this.fail('expected a key path after "query:"', head.start);
      return { kind: 'query', keys, op: op.value as SelectorOp, value, text };
    }

    const dot = key.indexOf('.');
    if (dot >= 0) {
      const pset = key.slice(0, dot);
      const prop = key.slice(dot + 1);
      if (pset.length === 0 || prop.length === 0) {
        this.fail(`"${key}" is not a property set and property name, e.g. Pset_WallCommon.FireRating`, head.start);
      }
      return {
        kind: 'property',
        pset: { kind: 'string', text: pset },
        prop: { kind: 'string', text: prop },
        op: op.value as SelectorOp,
        value,
        text,
      };
    }

    const keyword = KEYWORDS.get(key.toLowerCase());
    if (keyword) return { kind: keyword, op: op.value as SelectorOp, value, text };

    return { kind: 'attribute', name: key, op: op.value as SelectorOp, value, text };
  }

  /** A filter with no operator: a class name or a GlobalId. */
  private finishBare(first: Token, head: Token, negate: boolean): SelectorFilter {
    if (head.kind !== 'word') {
      this.fail(
        `"${head.value}" is not a filter: a quoted value or regular expression needs an attribute or property to compare, e.g. Name=${head.kind === 'regex' ? `/${head.value}/` : `"${head.value}"`}`,
        head.start,
      );
    }
    const text = this.spanFrom(first);
    if (head.value.includes('.')) {
      this.fail(
        `"${head.value}" reads as a property set and property name, so it needs one of the operators = != > >= < <= *= !*= and a value`,
        head.start,
      );
    }
    if (head.value.toLowerCase().startsWith('ifc')) {
      return { kind: 'class', name: head.value, negate, text };
    }
    if (GLOBAL_ID.test(head.value)) {
      return { kind: 'globalId', id: head.value, negate, text };
    }
    this.fail(
      `"${head.value}" is not an IFC class name (those start with "Ifc"), a 22-character GlobalId, or a comparison such as Name=${head.value}`,
      head.start,
    );
  }

  // ── Token helpers ───────────────────────────────────────────────────────

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): void {
    this.pos += 1;
  }

  private require(message: string): Token {
    const tok = this.peek();
    if (!tok || tok.kind === 'comma' || tok.kind === 'plus') {
      this.fail(message, tok ? tok.start : this.source.length);
    }
    return tok;
  }

  private requireOp(): Token {
    const tok = this.peek();
    if (!tok || tok.kind !== 'op') {
      this.fail(
        'expected one of the operators = != > >= < <= *= !*=',
        tok ? tok.start : this.source.length,
      );
    }
    this.advance();
    return tok;
  }

  private requireValue(op: Token): SelectorValue {
    const tok = this.peek();
    if (!tok || (tok.kind !== 'word' && tok.kind !== 'string' && tok.kind !== 'regex')) {
      this.fail(`expected a value after "${op.value}"`, tok ? tok.start : this.source.length);
    }
    this.advance();
    if (tok.kind === 'word' && tok.value.toUpperCase() === 'NULL') return { kind: 'null' };
    return nameOf(tok);
  }

  /** The source text from `first` through the token just consumed. */
  private spanFrom(first: Token): string {
    const last = this.tokens[this.pos - 1] as Token;
    return this.source.slice(first.start, last.end);
  }

  private failNegate(first: Token): never {
    this.fail('"!" may only negate a class name or a GlobalId', first.start);
  }

  private fail(message: string, offset: number): never {
    throw new ParseFailure({ message, offset });
  }
}

function nameOf(tok: Token): SelectorText {
  return tok.kind === 'regex' ? { kind: 'regex', source: tok.value } : { kind: 'string', text: tok.value };
}
