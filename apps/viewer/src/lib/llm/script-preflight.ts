/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NAMESPACE_SCHEMAS, type MethodPlacementKind } from '@ifc-lite/sandbox/schema';
import {
  createPreflightDiagnostic,
  formatDiagnosticsForDisplay,
  type PreflightScriptDiagnostic,
} from './script-diagnostics.js';

interface MethodRule {
  required: string[];
  anyOf?: string[][];
  positiveKeys?: string[];
  pointArity?: Record<string, number>;
  axisPair?: [string, string];
  forbidKeys?: Array<{ key: string; message: string }>;
  custom?: (body: string) => string[];
}

function createMethodRulesFromSchema(): Record<string, MethodRule> {
  const createNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'create');
  if (!createNamespace) return {};

  const rules: Record<string, MethodRule> = {};
  for (const method of createNamespace.methods) {
    const semantics = method.llmSemantics;
    if (!semantics?.requiredKeys?.length && !semantics?.anyOfKeys?.length && !semantics?.forbiddenKeys?.length) {
      continue;
    }

    let custom: ((body: string) => string[]) | undefined;
    switch (semantics.customValidationId) {
      case 'slab-shape':
        custom = validateSlabShape;
        break;
      case 'roof-shape':
        if (method.name === 'addIfcRoof' || method.name === 'addIfcGableRoof') {
          const roofMethod = method.name;
          custom = (body) => validateRoofShape(roofMethod, body);
        }
        break;
      case 'generic-element':
        custom = validateGenericElementShape;
        break;
      case 'axis-element':
        custom = validateAxisElementShape;
        break;
      default:
        custom = undefined;
    }

    rules[method.name] = {
      required: semantics.requiredKeys ?? [],
      anyOf: semantics.anyOfKeys,
      positiveKeys: semantics.positiveKeys,
      pointArity: semantics.pointArity,
      axisPair: semantics.axisPair,
      forbidKeys: semantics.forbiddenKeys,
      custom,
    };
  }
  return rules;
}

const METHOD_RULES: Record<string, MethodRule> = createMethodRulesFromSchema();

const SUSPICIOUS_BARE_IDENTIFIERS = new Set([
  'Position', 'Placement', 'Start', 'End', 'Width', 'Depth', 'Height', 'Thickness', 'Elevation', 'IfcType',
]);

function nearestMethodName(method: string, options: string[]): string | null {
  const lower = method.toLowerCase();
  const hit = options.find((m) => m.toLowerCase() === lower);
  if (hit) return hit;
  const close = options.find((m) => m.toLowerCase().includes(lower) || lower.includes(m.toLowerCase()));
  return close ?? null;
}

function scanToMatching(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | '\'' | '`' | null = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelItems(text: string): string[] {
  const items: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | '\'' | '`' | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;

    if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function hasKey(body: string, key: string): boolean {
  return new RegExp(String.raw`\b${key}\s*:`, 'm').test(body);
}

function findPropertyValue(body: string, key: string): string | null {
  const match = new RegExp(String.raw`\b${key}\s*:\s*`, 'm').exec(body);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const trimmed = body.slice(start).trimStart();
  if (!trimmed) return null;
  const offset = body.slice(start).length - trimmed.length;
  const absolute = start + offset;
  const first = body[absolute];
  if (first === '[') {
    const end = scanToMatching(body, absolute, '[', ']');
    return end >= 0 ? body.slice(absolute, end + 1) : null;
  }
  if (first === '{') {
    const end = scanToMatching(body, absolute, '{', '}');
    return end >= 0 ? body.slice(absolute, end + 1) : null;
  }
  const rest = body.slice(absolute);
  const top = splitTopLevelItems(rest);
  return top[0] ?? null;
}

function getArrayLiteralArity(body: string, key: string): number | null {
  const value = findPropertyValue(body, key);
  if (!value || !value.startsWith('[')) return null;
  return splitTopLevelItems(value.slice(1, -1)).length;
}

function getArrayLiteralItems(body: string, key: string): string[] | null {
  const value = findPropertyValue(body, key);
  if (!value || !value.startsWith('[')) return null;
  return splitTopLevelItems(value.slice(1, -1));
}

function parseNumericPointLiteral(body: string, key: string): number[] | null {
  const value = findPropertyValue(body, key);
  if (!value || !value.startsWith('[')) return null;
  const parts = splitTopLevelItems(value.slice(1, -1));
  if (parts.length === 0) return null;
  const nums = parts.map((part) => Number(part.trim()));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function getObjectBodiesForMethod(code: string, methodName: string): string[] {
  const marker = `bim.create.${methodName}(`;
  const bodies: string[] = [];
  let start = 0;
  while (true) {
    const idx = code.indexOf(marker, start);
    if (idx < 0) break;
    const openParen = idx + marker.length - 1;
    const closeParen = scanToMatching(code, openParen, '(', ')');
    if (closeParen < 0) break;
    const callBody = code.slice(openParen + 1, closeParen);
    let lastObject: string | null = null;
    for (let i = 0; i < callBody.length; i++) {
      if (callBody[i] !== '{') continue;
      const closeBrace = scanToMatching(callBody, i, '{', '}');
      if (closeBrace < 0) break;
      lastObject = callBody.slice(i + 1, closeBrace);
      i = closeBrace;
    }
    if (lastObject) bodies.push(lastObject);
    start = closeParen + 1;
  }
  return bodies;
}

interface MethodCallMatch {
  methodName: string;
  range: { from: number; to: number };
  snippet: string;
  line: number;
  column: number;
  unterminated: boolean;
}

function getMethodCalls(code: string, methodName: string): MethodCallMatch[] {
  const marker = `bim.create.${methodName}(`;
  const matches: MethodCallMatch[] = [];
  let start = 0;

  while (true) {
    const idx = code.indexOf(marker, start);
    if (idx < 0) break;
    const openParen = idx + marker.length - 1;
    const closeParen = scanToMatching(code, openParen, '(', ')');
    const unterminated = closeParen < 0;
    const end = unterminated ? findFallbackCallEnd(code, idx + marker.length) : closeParen + 1;
    const { line, column } = getLineAndColumn(code, idx);

    matches.push({
      methodName,
      range: { from: idx, to: end },
      snippet: code.slice(idx, end).trimEnd(),
      line,
      column,
      unterminated,
    });

    start = Math.max(end, idx + marker.length);
  }

  return matches;
}

function findFallbackCallEnd(code: string, start: number): number {
  const candidates = [
    code.indexOf('\n//', start),
    code.indexOf('\nconst ', start),
    code.indexOf('\nlet ', start),
    code.indexOf('\nvar ', start),
    code.indexOf('\nbim.create.', start),
    code.indexOf('\n\n', start),
  ].filter((value) => value >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : code.length;
}

function getLineAndColumn(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (code[i] === '\n') {
      line++;
      lastLineStart = i + 1;
    }
  }
  return { line, column: offset - lastLineStart + 1 };
}

function getLineSnippet(code: string, offset: number): string {
  const lineStart = code.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextBreak = code.indexOf('\n', offset);
  const lineEnd = nextBreak >= 0 ? nextBreak : code.length;
  return code.slice(lineStart, lineEnd).trimEnd();
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isIdentifierBoundary(code: string, index: number): boolean {
  if (index < 0 || index >= code.length) return true;
  return !isIdentifierPart(code[index]);
}

function skipStringLiteral(code: string, start: number): number {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote === '`' && char === '$' && code[index + 1] === '{') {
      const expressionEnd = scanToMatching(code, index + 1, '{', '}');
      if (expressionEnd < 0) return code.length;
      index = expressionEnd + 1;
      continue;
    }
    if (char === quote) return index + 1;
    index++;
  }
  return code.length;
}

function skipTrivia(code: string, start: number): number {
  let index = start;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < code.length && code[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index++;
      index = Math.min(code.length, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function readIdentifier(code: string, start: number): { value: string; end: number } | null {
  const index = skipTrivia(code, start);
  const char = code[index];
  if (!char || !isIdentifierStart(char)) return null;
  let end = index + 1;
  while (end < code.length && isIdentifierPart(code[end])) end++;
  return { value: code.slice(index, end), end };
}

function scanExpressionUntil(code: string, start: number, terminators: Set<string>): number {
  let index = start;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (index < code.length) {
    index = skipTrivia(code, index);
    if (index >= code.length) break;
    const char = code[index];

    if (char === '"' || char === '\'' || char === '`') {
      index = skipStringLiteral(code, index);
      continue;
    }

    if (char === '(') parenDepth++;
    else if (char === ')') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && terminators.has(char)) return index;
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === '[') bracketDepth++;
    else if (char === ']') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && terminators.has(char)) return index;
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === '{') braceDepth++;
    else if (char === '}') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && terminators.has(char)) return index;
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && terminators.has(char)) {
      return index;
    }

    index++;
  }

  return index;
}

function collectBindingsFromPattern(pattern: string, target: Set<string>): void {
  const code = pattern.trim();
  if (!code) return;

  function parsePattern(start: number, terminators: Set<string>): number {
    let index = skipTrivia(code, start);
    if (index >= code.length) return index;

    if (code.startsWith('...', index)) {
      return parsePattern(index + 3, terminators);
    }

    const char = code[index];
    if (char === '[') {
      index++;
      while (index < code.length) {
        index = skipTrivia(code, index);
        if (index >= code.length || code[index] === ']') return index + 1;
        if (code[index] === ',') {
          index++;
          continue;
        }
        index = parsePattern(index, new Set([',', ']']));
        index = skipTrivia(code, index);
        if (code[index] === '=') {
          index = scanExpressionUntil(code, index + 1, new Set([',', ']']));
        }
        index = skipTrivia(code, index);
        if (code[index] === ',') index++;
      }
      return index;
    }

    if (char === '{') {
      index++;
      while (index < code.length) {
        index = skipTrivia(code, index);
        if (index >= code.length || code[index] === '}') return index + 1;
        if (code[index] === ',') {
          index++;
          continue;
        }
        if (code.startsWith('...', index)) {
          index = parsePattern(index + 3, new Set([',', '}']));
        } else {
          if (code[index] === '[') {
            index = scanToMatching(code, index, '[', ']');
            index = index < 0 ? code.length : index + 1;
          } else if (code[index] === '"' || code[index] === '\'' || code[index] === '`') {
            index = skipStringLiteral(code, index);
          } else {
            const key = readIdentifier(code, index);
            if (key) {
              index = key.end;
              const afterKey = skipTrivia(code, index);
              if (code[afterKey] === ':') {
                index = parsePattern(afterKey + 1, new Set([',', '}', '=']));
              } else {
                target.add(key.value);
                index = afterKey;
              }
            } else {
              index++;
            }
          }
        }

        index = skipTrivia(code, index);
        if (code[index] === '=') {
          index = scanExpressionUntil(code, index + 1, new Set([',', '}']));
        }
        index = skipTrivia(code, index);
        if (code[index] === ',') index++;
      }
      return index;
    }

    const identifier = readIdentifier(code, index);
    if (identifier) {
      target.add(identifier.value);
      return identifier.end;
    }

    return scanExpressionUntil(code, index, terminators);
  }

  parsePattern(0, new Set());
}

function collectDeclaredIdentifiers(code: string): Set<string> {
  const declared = new Set<string>();

  const collectCommaSeparatedPatterns = (body: string) => {
    splitTopLevelItems(body).forEach((item) => {
      const trimmed = item.trim();
      if (!trimmed) return;
      const equalsIndex = scanExpressionUntil(trimmed, 0, new Set(['=']));
      const pattern = equalsIndex < trimmed.length ? trimmed.slice(0, equalsIndex) : trimmed;
      collectBindingsFromPattern(pattern, declared);
    });
  };

  const collectFunctionLikeBindings = (expression: string) => {
    const trimmed = expression.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('function') && isIdentifierBoundary(trimmed, 'function'.length)) {
      let cursor = skipTrivia(trimmed, 'function'.length);
      const name = readIdentifier(trimmed, cursor);
      if (name) {
        cursor = name.end;
      }
      cursor = skipTrivia(trimmed, cursor);
      if (trimmed[cursor] === '(') {
        const close = scanToMatching(trimmed, cursor, '(', ')');
        if (close >= 0) {
          collectCommaSeparatedPatterns(trimmed.slice(cursor + 1, close));
        }
      }
      return;
    }

    if (trimmed[0] === '(') {
      const close = scanToMatching(trimmed, 0, '(', ')');
      const afterClose = close >= 0 ? skipTrivia(trimmed, close + 1) : 0;
      if (close >= 0 && trimmed.startsWith('=>', afterClose)) {
        collectCommaSeparatedPatterns(trimmed.slice(1, close));
      }
      return;
    }

    const param = readIdentifier(trimmed, 0);
    const afterParam = param ? skipTrivia(trimmed, param.end) : 0;
    if (param && trimmed.startsWith('=>', afterParam)) {
      declared.add(param.value);
    }
  };

  const collectVariableDeclaration = (start: number): number => {
    let index = skipTrivia(code, start);

    while (index < code.length) {
      const declaratorEnd = scanExpressionUntil(code, index, new Set([',', ';', ')']));
      const declarator = code.slice(index, declaratorEnd);
      const ofOrInMatch = declarator.match(/^(.*?)(?=\s+\b(?:of|in)\b)/s);
      const bindingSegment = ofOrInMatch ? ofOrInMatch[1] : declarator;
      const equalsIndex = scanExpressionUntil(bindingSegment, 0, new Set(['=']));
      const pattern = equalsIndex < bindingSegment.length ? bindingSegment.slice(0, equalsIndex) : bindingSegment;
      collectBindingsFromPattern(pattern, declared);
      if (equalsIndex < bindingSegment.length) {
        collectFunctionLikeBindings(bindingSegment.slice(equalsIndex + 1));
      }

      index = skipTrivia(code, declaratorEnd);
      if (code[index] !== ',') return declaratorEnd;
      index++;
      index = skipTrivia(code, index);
    }

    return index;
  };

  for (let index = 0; index < code.length;) {
    index = skipTrivia(code, index);
    if (index >= code.length) break;

    const char = code[index];
    if (char === '"' || char === '\'' || char === '`') {
      index = skipStringLiteral(code, index);
      continue;
    }

    const variableKeyword = ['const', 'let', 'var'].find((keyword) =>
      code.startsWith(keyword, index)
      && isIdentifierBoundary(code, index - 1)
      && isIdentifierBoundary(code, index + keyword.length),
    );
    if (variableKeyword) {
      index = collectVariableDeclaration(index + variableKeyword.length);
      continue;
    }

    if (code.startsWith('function', index)
      && isIdentifierBoundary(code, index - 1)
      && isIdentifierBoundary(code, index + 'function'.length)) {
      let cursor = skipTrivia(code, index + 'function'.length);
      const name = readIdentifier(code, cursor);
      if (name) {
        declared.add(name.value);
        cursor = name.end;
      }
      cursor = skipTrivia(code, cursor);
      if (code[cursor] === '(') {
        const close = scanToMatching(code, cursor, '(', ')');
        if (close >= 0) {
          collectCommaSeparatedPatterns(code.slice(cursor + 1, close));
          index = close + 1;
          continue;
        }
      }
    }

    if (code.startsWith('catch', index)
      && isIdentifierBoundary(code, index - 1)
      && isIdentifierBoundary(code, index + 'catch'.length)) {
      let cursor = skipTrivia(code, index + 'catch'.length);
      if (code[cursor] === '(') {
        const close = scanToMatching(code, cursor, '(', ')');
        if (close >= 0) {
          collectBindingsFromPattern(code.slice(cursor + 1, close), declared);
          index = close + 1;
          continue;
        }
      }
    }

    index++;
  }

  return declared;
}

function validateKnownBimMethods(code: string): string[] {
  const errors: string[] = [];
  const byNamespace = new Map<string, Set<string>>();
  for (const schema of NAMESPACE_SCHEMAS) {
    byNamespace.set(schema.name, new Set(schema.methods.map((m) => m.name)));
  }

  const regex = /\bbim\.(\w+)\.(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    const namespace = match[1];
    const method = match[2];
    const knownMethods = byNamespace.get(namespace);
    if (!knownMethods) {
      errors.push(`Unknown namespace \`bim.${namespace}\`.`);
      continue;
    }
    if (!knownMethods.has(method)) {
      const suggestion = nearestMethodName(method, Array.from(knownMethods));
      errors.push(
        suggestion
          ? `Unknown method \`bim.${namespace}.${method}()\`. Did you mean \`bim.${namespace}.${suggestion}()\`?`
          : `Unknown method \`bim.${namespace}.${method}()\`.`,
      );
    }
  }
  return errors;
}

function validatePositiveLiterals(body: string, methodName: string, keys: string[]): string[] {
  const errors: string[] = [];
  for (const key of keys) {
    const value = findPropertyValue(body, key);
    if (!value) continue;
    const n = Number(value.trim());
    if (!Number.isNaN(n) && n <= 0) {
      errors.push(`\`bim.create.${methodName}(...)\` requires \`${key}\` to be > 0.`);
    }
  }
  return errors;
}

function validatePointArities(body: string, methodName: string, pointArity: Record<string, number>): string[] {
  const errors: string[] = [];
  for (const [key, arity] of Object.entries(pointArity)) {
    const actual = getArrayLiteralArity(body, key);
    if (actual !== null && actual !== arity) {
      errors.push(`\`bim.create.${methodName}(...)\` expects \`${key}\` to be a ${arity}D point array.`);
    }
  }
  return errors;
}

function validateAxisPair(body: string, methodName: string, startKey: string, endKey: string): string[] {
  const start = parseNumericPointLiteral(body, startKey);
  const end = parseNumericPointLiteral(body, endKey);
  if (!start || !end) return [];
  if (start.length === end.length && start.every((value, index) => value === end[index])) {
    return [`\`bim.create.${methodName}(...)\` requires \`${startKey}\` and \`${endKey}\` to define a non-zero axis.`];
  }
  return [];
}

function validateAlternativeShapes(body: string, methodName: string, anyOf: string[][]): string[] {
  if (anyOf.some((group) => group.every((key) => hasKey(body, key)))) {
    return [];
  }
  return [
    `\`bim.create.${methodName}(...)\` requires one of: ${anyOf.map((group) => group.map((key) => `\`${key}\``).join(' + ')).join(' OR ')}.`,
  ];
}

function validateForbiddenKeys(body: string, forbidKeys: Array<{ key: string; message: string }>): string[] {
  return forbidKeys.filter(({ key }) => hasKey(body, key)).map(({ message }) => message);
}

function validateSlabShape(body: string): string[] {
  const errors: string[] = [];
  const profileValue = findPropertyValue(body, 'Profile');
  if (profileValue?.startsWith('{')) {
    errors.push('`bim.create.addIfcSlab(...)` expects `Profile` to be a 2D point array, not a generic profile object.');
  }
  return errors;
}

function validateRoofShape(methodName: 'addIfcRoof' | 'addIfcGableRoof', body: string): string[] {
  const errors: string[] = [];
  const slopeValue = findPropertyValue(body, 'Slope');
  if (slopeValue) {
    const slope = Number(slopeValue.trim());
    if (!Number.isNaN(slope) && slope >= Math.PI / 2) {
      errors.push(
        `\`bim.create.${methodName}(...)\` expects \`Slope\` in radians between 0 and π/2. If you meant degrees, convert them first (for example \`15 * Math.PI / 180\`).`,
      );
    }
  }

  const overhangValue = findPropertyValue(body, 'Overhang');
  if (overhangValue) {
    const overhang = Number(overhangValue.trim());
    if (!Number.isNaN(overhang) && overhang < 0) {
      errors.push(`\`bim.create.${methodName}(...)\` requires \`Overhang\` to be >= 0.`);
    }
  }

  if (methodName === 'addIfcRoof') {
    const nameValue = findPropertyValue(body, 'Name');
    if (nameValue && /gable/i.test(nameValue)) {
      errors.push('`bim.create.addIfcRoof(...)` is a flat/mono-pitch roof helper. Use `bim.create.addIfcGableRoof(...)` for standard dual-pitch or gable roofs.');
    }
  }

  return errors;
}

function validateGenericElementShape(body: string): string[] {
  const errors: string[] = [];
  if (hasKey(body, 'Type')) {
    errors.push('`bim.create.addElement(...)` uses `IfcType`, not `Type`.');
  }
  if (hasKey(body, 'Position')) {
    errors.push('`bim.create.addElement(...)` uses `Placement: { Location: [...] }`, not `Position`.');
  }
  if (hasKey(body, 'Height')) {
    errors.push('`bim.create.addElement(...)` uses `Depth`, not `Height`.');
  }
  if (hasKey(body, 'ExtrusionHeight')) {
    errors.push('`bim.create.addElement(...)` uses `Depth`, not `ExtrusionHeight`.');
  }
  const placementValue = findPropertyValue(body, 'Placement');
  if (placementValue?.startsWith('{') && !/\bLocation\s*:/.test(placementValue)) {
    errors.push('`bim.create.addElement(...)` requires `Placement.Location`.');
  }
  const profileValue = findPropertyValue(body, 'Profile');
  if (profileValue?.startsWith('{')) {
    if (!/\bProfileType\s*:/.test(profileValue)) {
      errors.push('`bim.create.addElement(...)` requires a valid IFC-style `Profile` object with `ProfileType`.');
    }
    if (/\bkind\s*:|\bxDim\s*:|\byDim\s*:/.test(profileValue)) {
      errors.push('`bim.create.addElement(...)` profile keys must use IFC casing such as `XDim`, `YDim`, `Radius`, `OuterCurve`, and `ProfileType`.');
    }
  }
  return errors;
}

function validateAxisElementShape(body: string): string[] {
  const errors: string[] = [];
  if (hasKey(body, 'Type')) {
    errors.push('`bim.create.addAxisElement(...)` uses `IfcType`, not `Type`.');
  }
  const profileValue = findPropertyValue(body, 'Profile');
  if (profileValue?.startsWith('{') && !/\bProfileType\s*:/.test(profileValue)) {
    errors.push('`bim.create.addAxisElement(...)` requires a valid IFC-style `Profile` object with `ProfileType`.');
  }
  return errors;
}

function validateCreateContracts(code: string): string[] {
  const errors: string[] = [];
  for (const [methodName, rule] of Object.entries(METHOD_RULES)) {
    const objectBodies = getObjectBodiesForMethod(code, methodName);
    for (const body of objectBodies) {
      const missing = rule.required.filter((key) => !hasKey(body, key));
      if (missing.length > 0) {
        errors.push(`\`bim.create.${methodName}(...)\` is missing required key(s): ${missing.map((key) => `\`${key}\``).join(', ')}.`);
      }
      if (rule.anyOf) errors.push(...validateAlternativeShapes(body, methodName, rule.anyOf));
      if (rule.positiveKeys) errors.push(...validatePositiveLiterals(body, methodName, rule.positiveKeys));
      if (rule.pointArity) errors.push(...validatePointArities(body, methodName, rule.pointArity));
      if (rule.axisPair) errors.push(...validateAxisPair(body, methodName, rule.axisPair[0], rule.axisPair[1]));
      if (rule.forbidKeys) errors.push(...validateForbiddenKeys(body, rule.forbidKeys));
      if (rule.custom) errors.push(...rule.custom(body));
    }
  }
  return errors;
}

function validateBareIdentifierTraps(code: string): string[] {
  const errors: string[] = [];
  for (const methodName of Object.keys(METHOD_RULES)) {
    for (const objectBody of getObjectBodiesForMethod(code, methodName)) {
      const valueRegex = /:\s*([A-Za-z_]\w*)\s*(?=,|$)/g;
      let valueMatch: RegExpExecArray | null;
      while ((valueMatch = valueRegex.exec(objectBody)) !== null) {
        const ident = valueMatch[1];
        if (SUSPICIOUS_BARE_IDENTIFIERS.has(ident)) {
          errors.push(
            `Suspicious bare identifier value \`${ident}\` in BIM parameter object. Use a literal/array (e.g. \`${ident}: [..]\` or \`${ident}: 1\`) or declare the variable explicitly.`,
          );
        }
      }
    }
  }
  return errors;
}

function validateWallHostedOpeningDiagnostics(code: string): PreflightScriptDiagnostic[] {
  const hasWallCalls = code.includes('bim.create.addIfcWall(');
  if (!hasWallCalls) return [];

  const hasWallOpenings = /\bOpenings\s*:/.test(code);
  if (hasWallOpenings) return [];

  const diagnostics: PreflightScriptDiagnostic[] = [];
  const methodMessages = {
    addIfcWindow: 'Suspicious pattern: `bim.create.addIfcWindow(...)` is being used alongside walls, but no wall `Openings` are defined. `addIfcWindow(...)` creates a standalone axis-aligned window and will not auto-align or host into a wall. For wall-hosted inserts, use `bim.create.addIfcWallWindow(...)` or `Openings` on `bim.create.addIfcWall(...)`.',
    addIfcDoor: 'Suspicious pattern: `bim.create.addIfcDoor(...)` is being used alongside walls, but no wall `Openings` are defined. `addIfcDoor(...)` creates a standalone axis-aligned door and will not auto-align or host into a wall. For wall-hosted inserts, use `bim.create.addIfcWallDoor(...)` or `Openings` on `bim.create.addIfcWall(...)`.',
  } satisfies Record<'addIfcWindow' | 'addIfcDoor', string>;

  for (const methodName of Object.keys(methodMessages) as Array<'addIfcWindow' | 'addIfcDoor'>) {
    for (const match of getMethodCalls(code, methodName)) {
      diagnostics.push(createPreflightDiagnostic(
        'wall_hosted_opening_pattern',
        methodMessages[methodName],
        'error',
        {
          methodName,
          symbol: 'Openings',
          failureKind: 'standalone_opening',
          range: match.range,
          line: match.line,
          column: match.column,
          snippet: match.snippet,
          fixHint: `Replace this ${methodName === 'addIfcDoor' ? 'door' : 'window'} call with a wall-hosted insert or add it through the host wall's \`Openings\` payload.`,
          unterminated: match.unterminated,
        },
      ));
    }
  }

  return diagnostics;
}

function validateMetadataQueryPatterns(code: string): string[] {
  const errors: string[] = [];

  if (/bim\.query\.property\(\s*[^,]+,\s*["'`]Pset_MaterialCommon["'`]/.test(code) || /bim\.query\.property\(\s*[^,]+,\s*["'`]Material["'`]\s*,\s*["'`]Name["'`]/.test(code)) {
    errors.push('Suspicious material lookup: materials are usually not stored as ordinary property-set values. Prefer `bim.query.materials(entity)` over querying `Pset_MaterialCommon` or `Material.Name` as a property set.');
  }

  return errors;
}

function looksLikeMultiStoreyScript(code: string): boolean {
  const hasStoreyLoop = /for\s*\([^)]*;\s*[^;]*\b(storeyCount|levels?|floors?)\b/i.test(code) || /for\s*\(\s*let\s+\w+\s*=\s*0\s*;[^)]*<\s*\w+Count/i.test(code);
  const hasStoreyCreation = code.includes('bim.create.addIfcBuildingStorey(');
  return hasStoreyLoop && hasStoreyCreation;
}

/**
 * Names that can only mean the storey elevation. Spelling alone is proof for
 * these, so no further evidence is required. Deliberately does NOT include a
 * bare `z`: `Position: [x, y, z]` is the most ordinary line in a generated
 * script and flagging it would make this check noise.
 */
const UNAMBIGUOUS_ELEVATION_NAMES = /\b(elevation|storeyElevation|levelElevation)\b/i;

/**
 * Names that USUALLY mean the storey elevation but legitimately mean a local
 * offset too (`const baseZ = 0.5`). These need corroborating evidence from the
 * declaration before they are treated as the elevation.
 */
const AMBIGUOUS_ELEVATION_NAMES = /\b(baseZ|levelZ|storeyZ)\b/i;

/** A Z expression that is just a number carries no elevation, whatever it is called. */
function isNumericLiteralExpression(value: string): boolean {
  return /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(value.trim());
}

/**
 * `const|let|var <name> = <init>` for every simple declaration in the script.
 * One level deep on purpose — see `validateStoreyElevationDoubling`.
 */
function collectSimpleInitializers(code: string): Map<string, string> {
  const initializers = new Map<string, string>();
  const declRegex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(code)) !== null) {
    // A name reassigned later is not something one initializer can vouch for.
    if (initializers.has(match[1])) {
      initializers.set(match[1], '');
      continue;
    }
    initializers.set(match[1], match[2].trim());
  }
  return initializers;
}

/**
 * The exact expressions handed to `addIfcBuildingStorey({ Elevation: … })`.
 * Numeric literals are excluded: `Elevation: 0` next to `Position: [0, 0, 0]`
 * is a textual coincidence, not a data-flow fact.
 */
function collectStoreyElevationExpressions(code: string): Set<string> {
  const expressions = new Set<string>();
  for (const body of getObjectBodiesForMethod(code, 'addIfcBuildingStorey')) {
    const value = findPropertyValue(body, 'Elevation');
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || isNumericLiteralExpression(trimmed)) continue;
    expressions.add(trimmed);
  }
  return expressions;
}

interface ElevationEvidence {
  initializers: Map<string, string>;
  storeyElevationExpressions: Set<string>;
}

/**
 * Does this Z expression carry the storey elevation?
 *
 * Three independent kinds of evidence, in increasing order of how much work
 * they do:
 *
 *  1. The expression itself is spelled with an unambiguous elevation word.
 *  2. The expression is textually the same non-literal expression the script
 *     passed as the storey's own `Elevation`. This is the data-flow fact, not
 *     a name: `Elevation: i * 3.5` + `Position: [0, 0, i * 3.5]` is caught even
 *     though nothing in it is called "elevation".
 *  3. An identifier in the expression is DECLARED from something matching (1)
 *     or (2). This catches `const e = storeyElevation; …, e]` — an ordinary
 *     name that holds the elevation — and, in the other direction, it is what
 *     lets `const baseZ = 0.5` NOT be flagged: an ambiguous name resolving to a
 *     plain number is a local offset, not the storey datum.
 */
function carriesStoreyElevation(value: string, evidence: ElevationEvidence): boolean {
  const expression = value.trim();
  if (!expression || isNumericLiteralExpression(expression)) return false;
  if (UNAMBIGUOUS_ELEVATION_NAMES.test(expression)) return true;
  if (evidence.storeyElevationExpressions.has(expression)) return true;

  for (const identifier of expression.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const initializer = evidence.initializers.get(identifier);
    if (initializer === undefined || initializer === '') continue;
    if (isNumericLiteralExpression(initializer)) continue;
    if (UNAMBIGUOUS_ELEVATION_NAMES.test(initializer)) return true;
    if (evidence.storeyElevationExpressions.has(initializer)) return true;
  }

  // Last resort: an ambiguous name with no declaration in the script at all.
  // Nothing contradicts it, and the doubling it would cause is silent.
  return AMBIGUOUS_ELEVATION_NAMES.test(expression)
    && (expression.match(/[A-Za-z_$][\w$]*/g) ?? []).every((id) => !evidence.initializers.has(id));
}

/** Coordinate keys probed when a method declares no point contract of its own. */
const DEFAULT_ELEVATION_Z_KEYS = ['Position', 'Start', 'End', 'Location'];

/**
 * Every create method whose coordinates resolve against the storey, with the
 * keys that hold a Z. Derived from the bridge schema rather than hand-listed so
 * a constructor cannot be converted to storey placement without this check
 * seeing it. `explicit-placement` (`addElement`) is included because its
 * `Placement.Location` is resolved against the storey too, and `wall-local`
 * because a wall-hosted insert inherits the storey datum through its host.
 */
function buildElevationSensitiveMethods(): Array<{ methodName: string; keys: string[] }> {
  const createNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'create');
  if (!createNamespace) return [];

  const frames = new Set<MethodPlacementKind>(['storey-relative', 'explicit-placement', 'wall-local']);
  const checks: Array<{ methodName: string; keys: string[] }> = [];

  for (const method of createNamespace.methods) {
    const semantics = method.llmSemantics;
    if (!semantics?.placement || !frames.has(semantics.placement)) continue;

    const declared = new Set<string>();
    for (const [key, arity] of Object.entries(semantics.pointArity ?? {})) {
      if (arity >= 3) declared.add(key);
    }
    for (const key of semantics.axisPair ?? []) declared.add(key);

    checks.push({
      methodName: method.name,
      keys: declared.size > 0 ? [...declared] : DEFAULT_ELEVATION_Z_KEYS,
    });
  }

  return checks;
}

const ELEVATION_SENSITIVE_METHODS = buildElevationSensitiveMethods();

/**
 * The storey elevation applied TWICE.
 *
 * Every `bim.create.addIfc*(h, storey, …)` coordinate is storey-relative — the
 * storey's own placement is what carries `Elevation`, and the builder applies
 * it exactly once. A script that also writes the level elevation into an
 * element's Z inside a storey loop puts that element at 2x the elevation.
 * That is invisible in plan and easy to miss in a screenshot, which is why it
 * is worth a preflight error rather than a warning.
 *
 * (This check used to assert the OPPOSITE — `@ifc-lite/create` placed a handful
 * of constructors against the world until 2.0.0, so the advice then was to add
 * the elevation. Following that advice now is the bug.)
 *
 * KNOWN LIMITS. `carriesStoreyElevation` resolves one level of declaration and
 * compares against the literal text of the storey's own `Elevation` expression.
 * It is not a data-flow analysis: an elevation reaching Z through a function
 * parameter, an array or object member, a reassignment, or two hops of aliasing
 * is not seen. Those cases stay silent rather than being guessed at, because a
 * false rejection aborts the whole script in `useSandbox.execute()`.
 */
function validateStoreyElevationDoubling(code: string): PreflightScriptDiagnostic[] {
  if (!looksLikeMultiStoreyScript(code)) return [];

  const diagnostics: PreflightScriptDiagnostic[] = [];
  const evidence: ElevationEvidence = {
    initializers: collectSimpleInitializers(code),
    storeyElevationExpressions: collectStoreyElevationExpressions(code),
  };

  for (const { methodName, keys } of ELEVATION_SENSITIVE_METHODS) {
    for (const match of getMethodCalls(code, methodName)) {
      const body = getObjectBodiesForMethod(match.snippet, methodName)[0];
      if (!body) continue;
      const zValues = keys
        .map((key) => {
          const items = getArrayLiteralItems(body, key);
          return items && items.length >= 3 ? items[2].trim() : null;
        })
        .filter((value): value is string => Boolean(value));

      if (zValues.length === 0) continue;
      if (!zValues.some((value) => carriesStoreyElevation(value, evidence))) continue;

      diagnostics.push(createPreflightDiagnostic(
        'storey_elevation_double_applied',
        `Storey elevation applied twice: \`bim.create.${methodName}(...)\` writes the level elevation into its Z coordinate, but the storey placement already carries \`Elevation\`. This puts the element at 2x the level height. Use a storey-relative Z (usually \`0\`).`,
        'error',
        {
          methodName,
          failureKind: 'storey_elevation_double_applied',
          range: match.range,
          line: match.line,
          column: match.column,
          snippet: match.snippet,
          fixHint: 'Drop the storey elevation from this Z coordinate — coordinates are relative to the storey you passed.',
        },
      ));
    }
  }

  return diagnostics;
}

function validateDetachedSnippetScope(code: string): PreflightScriptDiagnostic[] {
  const diagnostics: PreflightScriptDiagnostic[] = [];
  const declared = collectDeclaredIdentifiers(code);

  const maybePushIdentifierDiagnostic = (identifier: string, message: string) => {
    const match = new RegExp(String.raw`\b${identifier}\b`).exec(code);
    const offset = match?.index ?? 0;
    const { line, column } = getLineAndColumn(code, offset);
    diagnostics.push(createPreflightDiagnostic(
      'detached_snippet_scope',
      message,
      'error',
      {
        symbol: identifier,
        failureKind: 'missing_context_binding',
        range: { from: offset, to: offset + identifier.length },
        line,
        column,
        snippet: getLineSnippet(code, offset),
        fixHint: 'Patch the existing full script or restore the missing surrounding declarations instead of returning an isolated fragment.',
      },
    ));
  };

  if (/\bbim\.create\.[A-Za-z]+\(\s*h\s*,/.test(code) && !declared.has('h') && !/bim\.create\.project\(/.test(code)) {
    maybePushIdentifierDiagnostic('h', 'Detached snippet risk: BIM create calls reference `h`, but no project handle is declared in this script. Preserve the surrounding full script or recreate the project/context explicitly.');
  }

  if (/\bbim\.create\.[A-Za-z]+\(\s*h\s*,\s*storey\b/.test(code) && !declared.has('storey') && !/addIfcBuildingStorey\(/.test(code)) {
    maybePushIdentifierDiagnostic('storey', 'Detached snippet risk: BIM create calls reference `storey`, but no storey handle is declared in this script. Preserve the surrounding loop/context instead of returning a standalone fragment.');
  }

  for (const identifier of ['width', 'depth', 'i', 'z']) {
    if (new RegExp(String.raw`\b${identifier}\b`).test(code) && !declared.has(identifier)) {
      maybePushIdentifierDiagnostic(identifier, `Detached snippet risk: script references \`${identifier}\` without declaring it locally. If this is a fix for an existing script, patch the full script in place instead of returning an isolated fragment.`);
    }
  }

  return diagnostics;
}

export function validateScriptPreflightDetailed(code: string): PreflightScriptDiagnostic[] {
  return [
    ...validateKnownBimMethods(code).map((message) => createPreflightDiagnostic(
      message.startsWith('Unknown namespace') ? 'unknown_namespace' : 'unknown_method',
      message,
      'error',
      buildDiagnosticData(message),
    )),
    ...validateCreateContracts(code).map((message) => createPreflightDiagnostic('create_contract', message, 'error', buildDiagnosticData(message))),
    ...validateBareIdentifierTraps(code).map((message) => createPreflightDiagnostic('bare_identifier', message, 'error', buildDiagnosticData(message))),
    ...validateWallHostedOpeningDiagnostics(code),
    ...validateMetadataQueryPatterns(code).map((message) => createPreflightDiagnostic('metadata_query_pattern', message, 'error', buildDiagnosticData(message))),
    ...validateStoreyElevationDoubling(code),
    ...validateDetachedSnippetScope(code),
  ];
}

export function validateScriptPreflight(code: string): string[] {
  return formatDiagnosticsForDisplay(validateScriptPreflightDetailed(code));
}

function buildDiagnosticData(message: string): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  const methodMatch = /`bim\.\w+\.([A-Za-z0-9_]+)\([^`]*`/.exec(message);
  const symbolMatch = /`([A-Za-z_]\w*)`/.exec(message);

  if (methodMatch) data.methodName = methodMatch[1];
  if (symbolMatch) data.symbol = symbolMatch[1];

  return Object.keys(data).length > 0 ? data : undefined;
}
