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

  /**
   * Source text of the tokens consumed since offset `start`: remarks
   * dropped, any gap between tokens written as one space, string literals
   * verbatim.
   */
  sliceFrom(start: number, preserveSpacing = false): string {
    let first = this.pos;
    while (first > 0 && this.tokens[first - 1].start >= start) first--;
    let text = '';
    for (let i = first; i < this.pos; i++) {
      const t = this.tokens[i];
      if (i > first && t.start > this.tokens[i - 1].end) {
        const gap = this.source.slice(this.tokens[i - 1].end, t.start);
        text += preserveSpacing && !gap.trim() ? gap : ' ';
      }
      text += this.source.slice(t.start, t.end);
    }
    return text;
  }

  /** Throw at token `t`, by default the next unconsumed one. */
  fail(message: string, t: Token = this.peek()): never {
    const line = this.source.slice(0, t.start).split('\n').length;
    throw new ExpressSyntaxError(`${message} at line ${line}, found ${t.kind === 'eof' ? 'end of input' : `'${this.source.slice(t.start, t.end)}'`}`, t.start);
  }
}
