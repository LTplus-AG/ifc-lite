/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decisions of the CLA gate (scripts/cla-gate.mjs): which webhook means
 * what, who must have signed, whether they have, and what to tell them. No I/O.
 */
import { createHash } from 'node:crypto';

export const CLA_VERSION = '1.0';
/**
 * sha256 of CLA.md for CLA_VERSION. Changing the text without bumping the
 * version would let later signers sign different words under the same
 * version, so the gate refuses to run until both move together.
 */
export const CLA_SHA256 = '4588846418581ca944a6e1d092631146a93a56d8b4968c7b939f7d7817c72586';
export const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA';
export const SIGNATURE_BRANCH = 'cla-signatures';
export const SIGNATURE_PATH = `signatures/v${CLA_VERSION}.json`;
export const STATUS_CONTEXT = 'CLA';
export const COMMENT_MARKER = '<!-- cla-gate -->';
/** GitHub lists at most this many commits for a pull request, paginated or not. */
export const PR_COMMIT_LIMIT = 250;

/**
 * Exemptions are keyed on numeric account ids, not logins: a login can be
 * renamed and then registered by someone else, an id cannot.
 *
 * LTplus's own accounts never sign. `info@lt.plus` commits resolve to the
 * release-bot account, which GitHub types as a user, not a bot.
 */
export const LTPLUS_ACCOUNTS = new Map([
  [78563314, 'louistrue'],
  [335935680, 'ifc-lite-release-bot'],
]);
/** Bots whose own commits need no signer. Named list only: a `*[bot]` wildcard would let any app merge unsigned code. */
export const NAMED_BOTS = new Map([
  [37929162, 'mergify[bot]'],
  [49699333, 'dependabot[bot]'],
  [41898282, 'github-actions[bot]'],
]);
/**
 * Mergify's batch pull requests only carry commits from pull requests that
 * already passed this gate, so they are not checked again. Every other PR,
 * whoever opened it, has its commit authors checked.
 */
export const MERGE_QUEUE_ACCOUNT = 37929162;
/**
 * `Co-authored-by` emails that name no person who holds rights in the work:
 * AI coding assistants, and LTplus's own addresses. Every other co-author
 * must have signed, like a commit author.
 */
export const EXEMPT_COAUTHOR_EMAILS = new Set([
  'noreply@anthropic.com',
  'noreply@openai.com',
  'cursoragent@cursor.com',
  // GitHub Copilot's coding agent; its account is a user, not a bot, so it is named here.
  '223556219+copilot@users.noreply.github.com',
  'copilot@users.noreply.github.com',
  'louis@lt.plus',
  'info@lt.plus',
]);

export class ClaGateError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ClaGateError';
    this.reason = reason;
  }
}

const lower = (login) => (typeof login === 'string' ? login.trim().toLowerCase() : '');
const isBot = (user) => user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '');

const NOREPLY = /^(?:(\d+)\+)?([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i;

/**
 * The co-authors a commit message names, as GitHub reads them: lines
 * `Co-authored-by: Name <email>`, case-insensitive. A GitHub noreply address
 * names the account (with its id when the address carries one); any other
 * address is returned as an email.
 */
export function coAuthors(message) {
  const out = [];
  if (typeof message !== 'string') return out;
  for (const m of message.matchAll(/^[ \t]*co-authored-by:[^<\n]*<([^>\n]*)>/gim)) {
    const email = m[1].trim().toLowerCase();
    if (!email) continue;
    if (EXEMPT_COAUTHOR_EMAILS.has(email)) continue;
    const n = NOREPLY.exec(email);
    if (n) {
      const login = n[2];
      out.push({ user: { id: n[1] ? Number(n[1]) : undefined, login, type: /\[bot\]$/i.test(login) ? 'Bot' : 'User' } });
    } else out.push({ email });
  }
  return out;
}

/** Is this comment body the sign phrase? Case, outer whitespace and a final full stop are forgiven. */
export function isSignComment(body) {
  if (typeof body !== 'string') return false;
  return body.trim().replace(/\.$/, '').trim().toLowerCase() === SIGN_PHRASE.toLowerCase();
}

export function isRecheckComment(body) {
  return typeof body === 'string' && body.trim().toLowerCase() === 'recheck';
}

/**
 * What should this webhook do?
 *   evaluate: recompute the status of pull request `number`
 *   sign:     record a signature for `signer`, then evaluate
 *   backfill: recompute every open pull request
 *   ignore:   nothing to do
 */
export function decideEvent(eventName, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ClaGateError('BAD_EVENT', 'The webhook payload is not an object.');
  }
  if (eventName === 'pull_request_target') {
    if (!['opened', 'reopened', 'synchronize'].includes(payload.action)) return { action: 'ignore', reason: 'PR_ACTION' };
    const number = payload.pull_request?.number;
    if (!Number.isSafeInteger(number)) throw new ClaGateError('BAD_EVENT', 'Pull request event has no number.');
    return { action: 'evaluate', number };
  }
  if (eventName === 'issue_comment') {
    if (payload.action !== 'created') return { action: 'ignore', reason: 'COMMENT_ACTION' };
    if (!payload.issue?.pull_request) return { action: 'ignore', reason: 'NOT_A_PULL_REQUEST' };
    const number = payload.issue.number;
    const body = payload.comment?.body;
    if (isRecheckComment(body)) return { action: 'evaluate', number };
    if (!isSignComment(body)) return { action: 'ignore', reason: 'OTHER_COMMENT' };
    const user = payload.comment.user ?? {};
    if (isBot(user)) return { action: 'ignore', reason: 'BOT_CANNOT_SIGN' };
    if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') {
      throw new ClaGateError('BAD_EVENT', 'Sign comment has no readable author.');
    }
    return {
      action: 'sign',
      number,
      signer: { id: user.id, login: user.login },
      comment: { id: payload.comment.id, url: payload.comment.html_url, createdAt: payload.comment.created_at },
    };
  }
  // A manual run rechecks every open pull request: it gives PRs opened
  // before the gate existed a status, which a required check needs.
  if (eventName === 'workflow_dispatch') return { action: 'backfill' };
  return { action: 'ignore', reason: 'EVENT' };
}

/**
 * Who has to have signed for this pull request?
 *
 * The PR author plus every commit author GitHub links to an account. Commit
 * emails with no linked account cannot be matched to a signature, so they
 * block until the author links the email or a maintainer records an offline
 * signature for that email. App accounts other than the named bots cannot
 * sign, so their work blocks for a maintainer.
 *
 * `Co-authored-by` trailers count too: work a maintainer lands for someone
 * else carries their name only there. A GitHub noreply address names the
 * account, which must have signed; any other address must be covered by an
 * offline signature for that email. AI assistants and LTplus addresses are
 * exempt (EXEMPT_COAUTHOR_EMAILS).
 */
export function requiredSigners(pr, commits) {
  const author = pr?.user;
  if (!author?.login) throw new ClaGateError('BAD_PR', 'Pull request has no author.');
  if (author.id === MERGE_QUEUE_ACCOUNT) {
    return { exemptPr: true, signers: [], unlinked: [], coauthorEmails: [], unlistedBots: [], truncated: false };
  }
  const signers = new Map();
  const unlistedBots = new Set();
  const add = (user) => {
    if (!user?.login) return;
    if (LTPLUS_ACCOUNTS.has(user.id) || NAMED_BOTS.has(user.id)) return;
    // Only an id-less co-author address reaches here without an id.
    if (!Number.isSafeInteger(user.id) &&
      [...LTPLUS_ACCOUNTS.values(), ...NAMED_BOTS.values()].some((l) => lower(l) === lower(user.login))) return;
    if (isBot(user)) unlistedBots.add(user.login);
    else signers.set(user.id ?? lower(user.login), { id: user.id, login: user.login });
  };
  add(author);
  const unlinked = new Set();
  const coauthorEmails = new Set();
  for (const commit of commits ?? []) {
    if (commit?.author?.login) add(commit.author);
    else unlinked.add((commit?.commit?.author?.email || '').toLowerCase() || '(no email)');
    for (const co of coAuthors(commit?.commit?.message)) {
      if (co.user) {
        // An old-style noreply address has no id; the login alone still names the account.
        if (!Number.isSafeInteger(co.user.id)) delete co.user.id;
        add(co.user);
      } else coauthorEmails.add(co.email);
    }
  }
  const listed = commits?.length ?? 0;
  return {
    exemptPr: false,
    signers: [...signers.values()],
    unlinked: [...unlinked].sort(),
    coauthorEmails: [...coauthorEmails].sort(),
    unlistedBots: [...unlistedBots].sort(),
    // `pr.commits` is the real count; the listing stops at PR_COMMIT_LIMIT.
    truncated: Number.isSafeInteger(pr.commits) ? pr.commits > listed : listed >= PR_COMMIT_LIMIT,
  };
}

/**
 * Normalise a signature record, or refuse it. `offline` entries are email or
 * PDF signatures recorded by a maintainer with no personal details: a
 * `github_id` for anyone with an account, an `email` only for commits whose
 * email is linked to no account.
 */
export function validateRecord(record) {
  if (record === null || record === undefined) return { cla_version: CLA_VERSION, signatures: [], offline: [] };
  if (typeof record !== 'object' || Array.isArray(record)) {
    throw new ClaGateError('BAD_RECORD', 'The signature record is not a JSON object.');
  }
  const out = { cla_version: CLA_VERSION, ...record, signatures: record.signatures ?? [], offline: record.offline ?? [] };
  if (!Array.isArray(out.signatures) || !Array.isArray(out.offline)) {
    throw new ClaGateError('BAD_RECORD', 'The signature record has a non-array `signatures` or `offline` field.');
  }
  return out;
}

/** Matches on the numeric account id, which survives a username change. */
export function hasSigned(record, user) {
  const { signatures, offline } = validateRecord(record);
  return [...signatures, ...offline].some((s) =>
    (Number.isSafeInteger(user.id) && s.github_id === user.id) ||
    (!Number.isSafeInteger(user.id) && typeof s.login === 'string' && lower(s.login) === lower(user.login)));
}

export function emailCovered(record, email) {
  return validateRecord(record).offline.some((s) => typeof s.email === 'string' && s.email.toLowerCase() === email);
}

export function evaluate(pr, commits, record) {
  const req = requiredSigners(pr, commits);
  const base = { state: 'success', missing: [], unlinked: [], coauthorEmails: [], unlistedBots: [], truncated: false, exemptPr: req.exemptPr };
  if (req.exemptPr) return { ...base, description: 'Merge-queue batch; its pull requests were checked.' };
  const result = {
    ...base,
    missing: req.signers.filter((u) => !hasSigned(record, u)),
    unlinked: req.unlinked.filter((e) => !emailCovered(record, e)),
    coauthorEmails: req.coauthorEmails.filter((e) => !emailCovered(record, e)),
    unlistedBots: req.unlistedBots,
    truncated: req.truncated,
  };
  const problems = [];
  if (result.missing.length) problems.push(`not signed by ${result.missing.map((u) => `@${u.login}`).join(', ')}`);
  if (result.unlinked.length) problems.push(`${result.unlinked.length} commit email(s) not linked to an account`);
  if (result.coauthorEmails.length) problems.push(`${result.coauthorEmails.length} co-author email(s) not covered`);
  if (result.unlistedBots.length) problems.push(`unlisted bot ${result.unlistedBots.map((b) => `@${b}`).join(', ')}`);
  if (result.truncated) problems.push(`over ${PR_COMMIT_LIMIT} commits, authors not all visible`);
  if (problems.length === 0) return { ...result, description: `All contributors have signed CLA v${CLA_VERSION}.` };
  return { ...result, state: 'failure', description: `CLA v${CLA_VERSION}: ${problems.join('; ')}`.slice(0, 140) };
}

export function addSignature(record, { signer, comment, number, claSha256, claCommit }) {
  const base = validateRecord(record);
  if (hasSigned(base, signer)) return { record: base, added: false };
  const entry = {
    github_id: signer.id,
    login: signer.login,
    cla_version: CLA_VERSION,
    cla_sha256: claSha256,
    cla_commit: claCommit,
    signed_at: comment.createdAt,
    pull_request: number,
    comment_id: comment.id,
    comment_url: comment.url,
  };
  return { record: { ...base, signatures: [...base.signatures, entry] }, added: true };
}

export function commentBody(result, claUrl, faqUrl) {
  const lines = [COMMENT_MARKER];
  if (result.state === 'success') {
    lines.push(`Thank you. Everyone on this pull request has signed the [Contributor License Agreement](${claUrl}) v${CLA_VERSION}.`);
    return lines.join('\n');
  }
  lines.push(`Thank you for your contribution. Before it can be merged, the [LTplus AG Contributor License Agreement](${claUrl}) v${CLA_VERSION} check needs:`);
  if (result.missing.length) {
    lines.push(
      '', 'A signature from each person below:', '',
      ...result.missing.map((u) => `- [ ] @${u.login}`),
      '', 'To sign, post this exact comment on this pull request:', '', '```', SIGN_PHRASE, '```', '',
      'You sign once, and it covers your future pull requests. The CLA is a license, not a copyright ' +
        'transfer: you keep ownership of your work. It also lets LTplus license contributions under other ' +
        'terms, including commercial licenses, while keeping them open source. ' +
        `Questions are welcome in this thread, and the [CLA FAQ](${faqUrl}) explains why.`,
    );
  }
  if (result.unlinked.length) {
    lines.push(
      '', 'These commit emails are not linked to a GitHub account, so the check cannot tell who wrote the commits:', '',
      // Commit emails are attacker-controlled text inside a bot comment. With
      // backticks and newlines stripped the code span cannot be closed, and
      // GitHub renders nothing inside one: no links, no mentions.
      ...result.unlinked.map((e) => `- \`${e.replace(/[^A-Za-z0-9._%+\-@ ()]/g, '')}\``),
      '', 'Add the email to your GitHub account (Settings, Emails) and comment `recheck`, or re-author the commits ' +
        'with a linked email. If the author signed by email or PDF instead, a maintainer records that.',
    );
  }
  if (result.coauthorEmails?.length) {
    lines.push(
      '', 'These `Co-authored-by` emails are not GitHub noreply addresses, so the check cannot tell which account they belong to:', '',
      ...result.coauthorEmails.map((e) => `- \`${e.replace(/[^A-Za-z0-9._%+\-@ ()]/g, '')}\``),
      '', 'Write the trailer with the co-author\'s GitHub noreply address (`ID+login@users.noreply.github.com`, shown in ' +
        'their GitHub email settings) and push again, so they can sign here. If they signed by email or PDF instead, a maintainer records that.',
    );
  }
  if (result.unlistedBots.length) {
    lines.push('', `These app accounts opened or authored part of this pull request and are not on the CLA exempt list: ${result.unlistedBots.map((b) => `@${b}`).join(', ')}. A maintainer must check who wrote that work.`);
  }
  if (result.truncated) {
    lines.push('', `This pull request has more than ${PR_COMMIT_LIMIT} commits, and GitHub does not list the authors beyond that. Split it or squash it.`);
  }
  return lines.join('\n');
}

export function claFingerprint(text, expected = CLA_SHA256) {
  const header = text.split('\n').slice(0, 5).join('\n');
  if (!new RegExp(`^Version ${CLA_VERSION.replaceAll('.', '\\.')},`, 'm').test(header)) {
    throw new ClaGateError('CLA_VERSION_MISMATCH', `CLA.md does not declare "Version ${CLA_VERSION},"; bump CLA_VERSION with the text.`);
  }
  const sha = createHash('sha256').update(text).digest('hex');
  if (sha !== expected) {
    throw new ClaGateError(
      'CLA_TEXT_CHANGED',
      `CLA.md changed without a version bump (sha256 ${sha}). Bump CLA_VERSION and CLA_SHA256 together, so everyone re-signs.`,
    );
  }
  return sha;
}
