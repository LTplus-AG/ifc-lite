/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-level EXPRESS declarations with their constraint clauses: TYPE with
 * WHERE, ENTITY with DERIVE/INVERSE/UNIQUE/WHERE, FUNCTION and RULE. The
 * regex-based `express-parser.ts` stays the source of the type surface; this
 * parser is what the validator generator compiles from.
 */

import type {
  EntityDecl, ExpressRuleSchema, FunctionDecl, InverseAttribute, Redeclaration, RuleDecl, TypeDecl, UniqueRule, WhereRule,
} from './ast.js';
import { parseExpression } from './expression-parser.js';
import { tokenize } from './lexer.js';
import { parseLocals, parseStatements, parseTypeSpec } from './statement-parser.js';
import { TokenStream } from './token-stream.js';

/**
 * An optional `label :` before a WHERE or UNIQUE rule. Labels are EXPRESS
 * identifiers, so a repeat in any case is an error.
 */
function parseRuleLabel(s: TokenStream, taken: Set<string>): string | undefined {
  if (s.peek().kind !== 'id' || !s.isOp(':', 1)) return undefined;
  const t = s.peek();
  const label = s.expectIdentifier();
  if (taken.has(t.upper)) s.fail(`duplicate rule label ${label}`, t);
  taken.add(t.upper);
  s.next();
  return label;
}

/** A WHERE or UNIQUE rule before `labelRules` has named it. */
type Unlabelled<R extends { label: string }> = Omit<R, 'label'> & { label?: string };

/** Number unlabelled rules <prefix>1, <prefix>2, ..., skipping labels already `taken` (upper-cased). */
function labelRules<R extends { label: string }>(rules: Unlabelled<R>[], prefix: string, taken: Set<string>): R[] {
  let n = 0;
  const generate = () => {
    let label;
    do label = `${prefix}${++n}`; while (taken.has(label));
    return label;
  };
  return rules.map((r) => ({ ...r, label: r.label ?? generate() }) as R);
}

function parseWhereClause(s: TokenStream, end: string): WhereRule[] {
  if (!s.acceptKeyword('WHERE')) return [];
  const taken = new Set<string>();
  const rules: Unlabelled<WhereRule>[] = [];
  while (!s.isKeyword(end)) {
    const label = parseRuleLabel(s, taken);
    const start = s.peek().start;
    const expr = parseExpression(s);
    const source = s.sliceFrom(start);
    s.expectOp(';');
    rules.push({ label, expr, source });
  }
  return labelRules(rules, 'WR', taken);
}

function parseAttributeName(s: TokenStream): { name: string; redeclares?: Redeclaration } {
  if (!s.isKeyword('SELF')) return { name: s.expectIdentifier() };
  s.next();
  s.expectOp('\\');
  const entity = s.expectIdentifier();
  s.expectOp('.');
  const attribute = s.expectIdentifier();
  const name = s.acceptKeyword('RENAMED') ? s.expectIdentifier() : attribute;
  return { name, redeclares: { entity, attribute } };
}

function skipBalanced(s: TokenStream): void {
  s.expectOp('(');
  let depth = 1;
  while (depth > 0) {
    const t = s.next();
    if (t.kind === 'eof') s.fail('unbalanced parentheses');
    if (t.kind === 'op' && t.text === '(') depth++;
    if (t.kind === 'op' && t.text === ')') depth--;
  }
}

function parseEntityHeader(s: TokenStream, entity: EntityDecl): void {
  for (;;) {
    if (s.acceptKeyword('ABSTRACT')) { entity.abstract = true; continue; }
    if (s.acceptKeyword('SUPERTYPE')) {
      if (s.acceptKeyword('OF')) skipBalanced(s);
      continue;
    }
    if (s.acceptKeyword('SUBTYPE')) {
      s.expectKeyword('OF');
      s.expectOp('(');
      do entity.supertypes.push(s.expectIdentifier()); while (s.acceptOp(','));
      s.expectOp(')');
      continue;
    }
    break;
  }
  s.expectOp(';');
}

function parseInverse(s: TokenStream): InverseAttribute {
  const { name, redeclares } = parseAttributeName(s);
  s.expectOp(':');
  const inv: InverseAttribute = { name, entity: '', forAttribute: '' };
  if (redeclares) inv.redeclares = redeclares;
  if (s.isKeyword('SET') || s.isKeyword('BAG')) {
    inv.aggregate = s.next().upper === 'SET' ? 'SET' : 'BAG';
    if (s.acceptOp('[')) {
      inv.low = parseExpression(s);
      s.expectOp(':');
      inv.high = parseExpression(s);
      s.expectOp(']');
    }
    s.expectKeyword('OF');
  }
  inv.entity = s.expectIdentifier();
  s.expectKeyword('FOR');
  if (s.peek().kind === 'id' && s.isOp('.', 1)) {
    s.next();
    s.next();
  }
  inv.forAttribute = s.expectIdentifier();
  s.expectOp(';');
  return inv;
}

function parseUnique(s: TokenStream, taken: Set<string>): Unlabelled<UniqueRule> {
  const label = parseRuleLabel(s, taken);
  const attributes: UniqueRule['attributes'] = [];
  do {
    if (s.acceptKeyword('SELF')) {
      s.expectOp('\\');
      const entity = s.expectIdentifier();
      s.expectOp('.');
      attributes.push({ entity, name: s.expectIdentifier() });
    } else {
      attributes.push({ name: s.expectIdentifier() });
    }
  } while (s.acceptOp(','));
  s.expectOp(';');
  return { label, attributes };
}

function parseEntity(s: TokenStream): EntityDecl {
  const entity: EntityDecl = {
    name: s.expectIdentifier(), abstract: false, supertypes: [], explicit: [], derived: [], inverse: [], unique: [], where: [],
  };
  parseEntityHeader(s, entity);
  const sectionStart = () => ['DERIVE', 'INVERSE', 'UNIQUE', 'WHERE', 'END_ENTITY'].some((w) => s.isKeyword(w));
  while (!sectionStart()) {
    const names = [parseAttributeName(s)];
    while (s.acceptOp(',')) names.push(parseAttributeName(s));
    s.expectOp(':');
    const optional = s.acceptKeyword('OPTIONAL');
    const type = parseTypeSpec(s);
    s.expectOp(';');
    for (const n of names) entity.explicit.push({ ...n, optional, type });
  }
  if (s.acceptKeyword('DERIVE')) {
    while (!sectionStart()) {
      const { name, redeclares } = parseAttributeName(s);
      s.expectOp(':');
      const type = parseTypeSpec(s);
      s.expectOp(':=');
      const start = s.peek().start;
      const expr = parseExpression(s);
      const source = s.sliceFrom(start);
      s.expectOp(';');
      entity.derived.push(redeclares ? { name, type, expr, source, redeclares } : { name, type, expr, source });
    }
  }
  if (s.acceptKeyword('INVERSE')) {
    while (!sectionStart()) entity.inverse.push(parseInverse(s));
  }
  if (s.acceptKeyword('UNIQUE')) {
    const taken = new Set<string>();
    const unique: Unlabelled<UniqueRule>[] = [];
    while (!sectionStart()) unique.push(parseUnique(s, taken));
    entity.unique = labelRules(unique, 'UR', taken);
  }
  entity.where = parseWhereClause(s, 'END_ENTITY');
  s.expectKeyword('END_ENTITY');
  s.expectOp(';');
  return entity;
}

function parseType(s: TokenStream): TypeDecl {
  const name = s.expectIdentifier();
  s.expectOp('=');
  const spec = parseTypeSpec(s);
  s.expectOp(';');
  const where = parseWhereClause(s, 'END_TYPE');
  s.expectKeyword('END_TYPE');
  s.expectOp(';');
  return { name, spec, where };
}

function parseFunction(s: TokenStream): FunctionDecl {
  const name = s.expectIdentifier();
  const params: FunctionDecl['params'] = [];
  if (s.acceptOp('(')) {
    do {
      const names = [s.expectIdentifier()];
      while (s.acceptOp(',')) names.push(s.expectIdentifier());
      s.expectOp(':');
      const type = parseTypeSpec(s);
      for (const n of names) params.push({ name: n, type });
    } while (s.acceptOp(';'));
    s.expectOp(')');
  }
  s.expectOp(':');
  const returns = parseTypeSpec(s);
  s.expectOp(';');
  const locals = parseLocals(s);
  const body = parseStatements(s, ['END_FUNCTION']);
  s.expectKeyword('END_FUNCTION');
  s.expectOp(';');
  return { name, params, returns, locals, body };
}

function parseRule(s: TokenStream): RuleDecl {
  const name = s.expectIdentifier();
  s.expectKeyword('FOR');
  s.expectOp('(');
  const appliesTo: string[] = [];
  do appliesTo.push(s.expectIdentifier()); while (s.acceptOp(','));
  s.expectOp(')');
  s.expectOp(';');
  const locals = parseLocals(s);
  const body = parseStatements(s, ['WHERE', 'END_RULE']);
  const where = parseWhereClause(s, 'END_RULE');
  s.expectKeyword('END_RULE');
  s.expectOp(';');
  return { name, appliesTo, locals, body, where };
}

function skipDeclaration(s: TokenStream, end: string): void {
  while (!s.isKeyword(end)) {
    if (s.peek().kind === 'eof') s.fail(`expected ${end}`);
    s.next();
  }
  s.next();
  s.expectOp(';');
}

export function parseExpressRules(source: string): ExpressRuleSchema {
  const s = new TokenStream(tokenize(source), source);
  s.expectKeyword('SCHEMA');
  const schema: ExpressRuleSchema = { name: s.expectIdentifier(), types: [], entities: [], functions: [], rules: [], skipped: [] };
  s.expectOp(';');
  while (!s.isKeyword('END_SCHEMA')) {
    if (s.peek().kind === 'eof') s.fail('expected END_SCHEMA');
    const t = s.next();
    switch (t.upper) {
      case 'TYPE': schema.types.push(parseType(s)); break;
      case 'ENTITY': schema.entities.push(parseEntity(s)); break;
      case 'FUNCTION': schema.functions.push(parseFunction(s)); break;
      case 'RULE': schema.rules.push(parseRule(s)); break;
      case 'PROCEDURE': case 'SUBTYPE_CONSTRAINT':
        schema.skipped.push({ kind: t.upper, name: s.peek().text });
        skipDeclaration(s, `END_${t.upper}`);
        break;
      case 'CONSTANT':
        schema.skipped.push({ kind: t.upper, name: '' });
        skipDeclaration(s, 'END_CONSTANT');
        break;
      default:
        s.fail('expected a declaration at schema level', t);
    }
  }
  s.expectKeyword('END_SCHEMA');
  s.expectOp(';');
  if (s.peek().kind !== 'eof') s.fail('expected end of input after END_SCHEMA');
  return schema;
}
