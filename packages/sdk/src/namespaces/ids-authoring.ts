/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.ids.authoring — open, edit, lint and write IDS documents from a script.
 *
 * Edits go through the same typed operations and grounding gate as the IDS
 * editor and the MCP `ids_apply_ops` tool (`@ifc-lite/ids-authoring`): a
 * batch with a name the IFC schema does not know is refused as a whole, and
 * the result carries the gate's issues with ranked candidates. Accepted
 * batches go on an undo stack.
 *
 * ```ts
 * const doc = await bim.ids.authoring.open(xml);
 * const res = doc.apply(ops);
 * if (!res.ok) console.log(res.errors[0].candidates);
 * const diagnostics = doc.lint();
 * const out = doc.write();
 * ```
 */

import type {
  Diagnostic,
  GateContext,
  GateIssue,
  LintContext,
  LintSeverity,
  StudioDocument,
  StudioState,
} from '@ifc-lite/ids-authoring';

type AuthoringModule = typeof import('@ifc-lite/ids-authoring');
type WriterModule = typeof import('@ifc-lite/rules');

// Loaded on first use, like `@ifc-lite/ids` in `bim.ids`, so scripts that
// never author IDS do not pay for the schema tables.
async function load(): Promise<{ authoring: AuthoringModule; writer: WriterModule['writeIdsXml'] }> {
  const authoringName = '@ifc-lite/ids-authoring';
  const rulesName = '@ifc-lite/rules';
  const [authoring, rules] = await Promise.all([
    import(/* webpackIgnore: true */ authoringName) as Promise<AuthoringModule>,
    import(/* webpackIgnore: true */ rulesName) as Promise<WriterModule>,
  ]);
  return { authoring, writer: rules.writeIdsXml };
}

/** `ok` is false when the gate refused the batch; then `applied` is 0 and `errors` says why. */
export interface IDSAuthoringApplyResult {
  ok: boolean;
  /** Primitive ops applied (compound ops count once per expanded op). */
  applied: number;
  errors: GateIssue[];
}

export interface IDSAuthoringLintOptions {
  /** Only these rule codes. */
  rules?: string[];
  /** Per-rule severity override, `'off'` disables a rule. */
  severity?: Record<string, LintSeverity | 'off'>;
}

/** One open IDS document. Every change goes through `apply`. */
export class IDSAuthoringDocument {
  private state: StudioState;

  /** @internal Use `bim.ids.authoring.open` / `create`. */
  constructor(
    private readonly lib: AuthoringModule,
    private readonly writer: WriterModule['writeIdsXml'],
    private readonly gate: GateContext,
    private readonly lintCtx: LintContext,
    doc: StudioDocument,
  ) {
    this.state = lib.createStudioState(doc);
  }

  /** The current Studio document (IDS content plus node ids and sidecar). */
  get doc(): StudioDocument {
    return this.state.doc;
  }

  /**
   * Validate, gate and apply a batch of ops. A refused batch changes
   * nothing; `errors` says why, with candidates for each wrong name.
   */
  apply(ops: readonly unknown[]): IDSAuthoringApplyResult {
    const result = this.lib.applyOpsGated(this.state.doc, ops, this.gate);
    if (!result.ok) return { ok: false, applied: 0, errors: result.issues };
    this.state = this.lib.commit(this.state, result.applied, { source: { by: 'user' } }).state;
    return { ok: true, applied: result.applied.length, errors: [] };
  }

  /** Undo the last accepted batch. Returns false when there is nothing to undo. */
  undo(): boolean {
    if (!this.lib.canUndo(this.state)) return false;
    this.state = this.lib.undo(this.state);
    return true;
  }

  /** Redo the last undone batch. Returns false when there is nothing to redo. */
  redo(): boolean {
    if (!this.lib.canRedo(this.state)) return false;
    this.state = this.lib.redo(this.state);
    return true;
  }

  /** Lint diagnostics (IDSL rules) of the current document. */
  lint(options: IDSAuthoringLintOptions = {}): Diagnostic[] {
    return this.lib.lintDocument(this.state.doc, this.lintCtx, options).diagnostics;
  }

  /** The XML path of a node id, e.g. `specifications[0].requirements[1].baseName`. */
  pathOf(nodeId: string): string | undefined {
    return this.lib.nodePath(this.state.doc, nodeId);
  }

  /**
   * IDS 1.0 XML of the current document. Throws when the writer cannot
   * carry a value without loss (the message names each one) rather than
   * returning XML with less content.
   */
  write(): string {
    const out = this.lib.writeStudioDocument(this.state.doc, this.writer);
    if (out.ok) return out.xml;
    const lost = out.lost?.length ? `: ${out.lost.join(', ')}` : '';
    throw new Error(`bim.ids.authoring: cannot write this document (${out.message})${lost}`);
  }
}

/** bim.ids.authoring — IDS documents edited through typed, grounded operations. */
export class IDSAuthoringNamespace {
  private async context(): Promise<{ lib: AuthoringModule; writer: WriterModule['writeIdsXml']; gate: GateContext; lintCtx: LintContext }> {
    const { authoring, writer } = await load();
    const gate = await authoring.createGateContext();
    const lintCtx = await authoring.createLintContext({ gate });
    return { lib: authoring, writer, gate, lintCtx };
  }

  /** Open IDS XML for editing. Node ids depend only on the content. */
  async open(xml: string): Promise<IDSAuthoringDocument> {
    const { lib, writer, gate, lintCtx } = await this.context();
    return new IDSAuthoringDocument(lib, writer, gate, lintCtx, lib.readStudioDocument(xml));
  }

  /** Start an empty document. */
  async create(title = ''): Promise<IDSAuthoringDocument> {
    const { lib, writer, gate, lintCtx } = await this.context();
    return new IDSAuthoringDocument(lib, writer, gate, lintCtx, lib.createStudioDocument({ title }));
  }
}
