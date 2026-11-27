/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityDecl, TypeSpec } from '../express/ast.js';
import type { SchemaIndex } from './schema-index.js';

/** Thrown for an EXPRESS construct the translator cannot compile; the rule is reported, never dropped silently. */
export class UnsupportedConstruct extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedConstruct';
  }
}

export interface Variable {
  js: string;
  type?: TypeSpec;
}

export type ScopeKind = 'entity' | 'type' | 'function' | 'rule';

export class Scope {
  private readonly vars = new Map<string, Variable>();

  constructor(
    readonly kind: ScopeKind,
    readonly entity?: EntityDecl,
    readonly parent?: Scope,
    /** The innermost enclosing REPEAT; a SKIP in it names `label`, assigned on first use. */
    readonly loop?: { label?: string },
    readonly returnsSet = false,
  ) {}

  child(loop = this.loop): Scope {
    return new Scope(this.kind, this.entity, this, loop, this.returnsSet);
  }

  define(name: string, js: string, type?: TypeSpec): Variable {
    const v: Variable = type ? { js, type } : { js };
    this.vars.set(name.toUpperCase(), v);
    return v;
  }

  lookup(name: string): Variable | undefined {
    return this.vars.get(name.toUpperCase()) ?? this.parent?.lookup(name);
  }
}

/** Shared state while translating one schema. */
export class TranslateContext {
  /** Module-level constants (enumeration literals), name -> initialiser. */
  readonly constants = new Map<string, string>();
  /** Qualified upper name -> the failed declaration in EXPRESS spelling. */
  readonly failedDerived = new Map<string, string>();
  /** Functions the expression being translated calls (upper names). */
  calls = new Set<string>();
  private counter = 0;

  constructor(
    readonly index: SchemaIndex,
    /** Upper function name -> reason, for functions that did not compile. */
    readonly unsupportedFunctions: Map<string, string>,
  ) {}

  /** A reference to a derived attribute that did not compile makes the referring rule unsupported too. */
  checkDerived(upper: string, entity?: EntityDecl): void {
    if (!this.failedDerived.size) return;
    let failed: string | undefined;
    if (entity) {
      const owner = this.index.chain(entity).reverse().find(level =>
        [...level.explicit, ...level.derived, ...level.inverse].some(a => a.name.toUpperCase() === upper));
      if (owner) failed = this.failedDerived.get(`${owner.name.toUpperCase()}.${upper}`);
    } else {
      for (const [name, reason] of this.failedDerived) if (name.endsWith('.' + upper)) { failed = reason; break; }
    }
    if (failed) throw new UnsupportedConstruct(`depends on derived attribute ${failed}, which did not compile`);
  }

  fresh(prefix: string): string {
    return `${prefix}_${++this.counter}`;
  }

  enumLiteral(item: string): string {
    const name = `E_${item.toUpperCase()}`;
    this.constants.set(name, `new r.EnumValue(${JSON.stringify(item.toUpperCase())})`);
    return name;
  }
}

export function jsIdentifier(prefix: string, name: string): string {
  return `${prefix}${name.toLowerCase()}`;
}

export function functionIdentifier(name: string): string {
  return `fn_${name}`;
}
