/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sidecar-only ops for lint suppressions (P-04), comment threads
 * (IDS-108) and test suites (IDS-110). Re-exported from `types.ts`;
 * they never touch the IDS XML.
 */

import type { CommentThread, Suppression } from '../document/types.js';
import type { TestCase, TestExpectation } from '../testing/types.js';
import type { Uuid } from '../uuid.js';
import type { Op } from './types.js';

/**
 * Silence a lint rule on a node and everything below it
 * (`meta.suppressions[nodeId]`). `suppression.rule` is a full code
 * (`IDSL-SPEC-008`) or a wildcard (`IDSL-SPEC-*`); the reason is required.
 * A suppression of the same rule on the same node is replaced in place.
 */
export type MetaSuppressOp = Op<'meta.suppress', { nodeId: Uuid; suppression: Suppression; index?: number }>;
/**
 * Remove the suppression of `rule` from `nodeId`. `keepEmpty` is a
 * fidelity flag used by inverses: it keeps an empty list on the node
 * instead of dropping the key, so undo restores the sidecar exactly.
 */
export type MetaUnsuppressOp = Op<'meta.unsuppress', { nodeId: Uuid; rule: string; keepEmpty?: boolean }>;

/** One comment of a thread (sidecar only). */
export interface CommentDraft {
  author: string;
  /** ISO timestamp. */
  at: string;
  text: string;
}

/** Open a thread on a live node. */
export type MetaCommentAddOp = Op<'meta.comment.add', CommentDraft & { nodeId: Uuid; threadId: Uuid }>;
/** Append a comment to a thread. */
export type MetaCommentReplyOp = Op<'meta.comment.reply', CommentDraft & { threadId: Uuid }>;
/** Remove the last comment of a thread that has more than one (inverse of reply). */
export type MetaCommentRemoveReplyOp = Op<'meta.comment.removeReply', { threadId: Uuid }>;
export type MetaCommentResolveOp = Op<'meta.comment.resolve', { threadId: Uuid; resolved: boolean }>;
export type MetaCommentRemoveThreadOp = Op<'meta.comment.removeThread', { threadId: Uuid }>;
/** Add a test case to a specification's suite. */
export type MetaTestAddOp = Op<'meta.test.add', { specId: Uuid; testCase: TestCase; index?: number }>;
export type MetaTestRemoveOp = Op<'meta.test.remove', { testId: Uuid }>;
/** Put a test case back (inverse of remove; the specification may be gone, suites outlive it). */
export type MetaTestRestoreOp = Op<'meta.test.restore', { specId: Uuid; index: number; testCase: TestCase }>;
/** Change what a test case expects; `expectFailureOn: null` clears it. */
export type MetaTestSetExpectationOp = Op<
  'meta.test.setExpectation',
  { testId: Uuid; expect: TestExpectation; expectFailureOn: Uuid[] | null }
>;
/** Put a thread back (inverse of removeThread; the node may be gone, threads outlive nodes). */
export type MetaCommentRestoreThreadOp = Op<'meta.comment.restoreThread', { nodeId: Uuid; index: number; thread: CommentThread }>;
