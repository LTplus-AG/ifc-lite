/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ExpressSyntaxError, type Token } from './lexer.js';

export class TokenStream {
  private pos = 0;

  constructor(private readonly tokens: Token[], readonly source: string) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'id' && t.upper === word;
  }

  isOp(op: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'op' && t.text === op;
  }

  acceptKeyword(word: string): boolean {
    if (!this.isKeyword(word)) return false;
    this.next();
    return true;
  }

  acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.next();
    return true;
  }

  expectKeyword(word: string): Token {
    if (!this.isKeyword(word)) this.fail(`expected ${word}`);
    return this.next();
  }

  expectOp(op: string): Token {
    if (!this.isOp(op)) this.fail(`expected '${op}'`);
    return this.next();
  }

  expectIdentifier(): string {
    const t = this.peek();
    if (t.kind !== 'id') this.fail('expected identifier');
    return this.next().text;
  }

  /** Source text from `start` up to the end of the previously consumed token. */
  sliceFrom(start: number): string {
    const prev = this.tokens[Math.max(this.pos - 1, 0)];
    return this.source.slice(start, prev.end).replace(/\s+/g, ' ').trim();
  }

  /** Skip to just past the next top-level `;`, honouring brackets. */
  skipStatement(): void {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.kind !== 'op') continue;
      if (t.text === '(' || t.text === '[') depth++;
      else if (t.text === ')' || t.text === ']') depth--;
      else if (t.text === ';' && depth <= 0) return;
    }
  }

  fail(message: string): never {
    const t = this.peek();
    const line = this.source.slice(0, t.start).split('\n').length;
    throw new ExpressSyntaxError(`${message} at line ${line}, found '${t.text || 'end of input'}'`, t.start);
  }
}
