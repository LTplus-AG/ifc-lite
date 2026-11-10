/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLA_VERSION,
  SIGN_PHRASE,
  SIGNATURE_PATH,
  ClaGateError,
  addSignature,
  claFingerprint,
  coAuthors,
  commentBody,
  decideEvent,
  evaluate,
  isSignComment,
  recordSignature,
  requiredSigners,
  run,
} from './cla-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'LTplus-AG/ifc-lite';
const alice = { id: 101, login: 'alice', type: 'User' };
const bob = { id: 202, login: 'bob', type: 'User' };
const louis = { id: 78563314, login: 'louistrue', type: 'User' };
const commit = (author, email = `${author?.login ?? 'x'}@example.com`, message = 'change') => ({ author, commit: { author: { email }, message } });
const signedBy = (...users) => ({
  cla_version: CLA_VERSION,
  signatures: users.map((u) => ({ github_id: u.id, login: u.login })),
});

test('the CLA in the repository declares the version the gate records', () => {
  const text = readFileSync(join(ROOT, 'CLA.md'), 'utf8');
  assert.match(claFingerprint(text), /^[0-9a-f]{64}$/);
  assert.ok(text.includes(SIGN_PHRASE), 'CLA.md must quote the exact sign phrase');
});

test('a CLA text with another version is refused rather than signed under the wrong version', () => {
  assert.throws(() => claFingerprint('# CLA\n\nVersion 2.0, 2027\n'), (e) => e instanceof ClaGateError && e.reason === 'CLA_VERSION_MISMATCH');
  assert.throws(() => claFingerprint('# CLA\n\nVersion 1.01, 2027\n'), (e) => e.reason === 'CLA_VERSION_MISMATCH');
});

test('editing the CLA text without bumping the version is refused, so nobody signs changed words under v1.0', () => {
  const text = readFileSync(join(ROOT, 'CLA.md'), 'utf8');
  assert.throws(() => claFingerprint(`${text}\nOne more sentence.\n`), (e) => e.reason === 'CLA_TEXT_CHANGED');
});

test('the sign phrase forgives case, outer whitespace and a final full stop, nothing else', () => {
  assert.equal(isSignComment(`  ${SIGN_PHRASE.toUpperCase()}. \n`), true);
  assert.equal(isSignComment(`${SIGN_PHRASE} please`), false);
  assert.equal(isSignComment(`> ${SIGN_PHRASE}`), false);
  assert.equal(isSignComment(undefined), false);
});

test('pull request events evaluate; closed and labeled do not', () => {
  assert.deepEqual(decideEvent('pull_request_target', { action: 'synchronize', pull_request: { number: 7 } }), { action: 'evaluate', number: 7 });
  assert.equal(decideEvent('pull_request_target', { action: 'closed', pull_request: { number: 7 } }).action, 'ignore');
});

test('a sign comment on a pull request signs for its commenter only', () => {
  const d = decideEvent('issue_comment', {
    action: 'created',
    issue: { number: 9, pull_request: {} },
    comment: { id: 5, body: SIGN_PHRASE, html_url: 'u', created_at: 't', user: alice },
  });
  assert.equal(d.action, 'sign');
  assert.deepEqual(d.signer, { id: 101, login: 'alice' });
});

test('a sign comment on an issue, or from a bot, records nothing', () => {
  const base = { action: 'created', comment: { id: 5, body: SIGN_PHRASE, user: alice } };
  assert.equal(decideEvent('issue_comment', { ...base, issue: { number: 9 } }).reason, 'NOT_A_PULL_REQUEST');
  assert.equal(
    decideEvent('issue_comment', { ...base, issue: { number: 9, pull_request: {} }, comment: { ...base.comment, user: { id: 1, login: 'x[bot]', type: 'Bot' } } }).reason,
    'BOT_CANNOT_SIGN',
  );
});

test('the PR author and every linked commit author must sign; LTplus never does', () => {
  const { signers, unlinked } = requiredSigners({ user: louis }, [commit(alice), commit(louis), commit(null, 'ghost@example.com')]);
  assert.deepEqual(signers.map((u) => u.login), ['alice']);
  assert.deepEqual(unlinked, ['ghost@example.com']);
});

test('a maintainer taking over a contributor branch still needs the contributor signature', () => {
  const r = evaluate({ user: louis }, [commit(bob)], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing.map((u) => u.login), ['bob']);
});

test('a merge-queue batch is not checked again: its pull requests passed the gate', () => {
  const r = evaluate({ user: { id: 37929162, login: 'mergify[bot]', type: 'Bot' } }, [commit(bob)], signedBy());
  assert.equal(r.state, 'success');
});

test('signatures match on the account id, so a renamed account stays signed', () => {
  const r = evaluate({ user: { ...alice, login: 'alice-renamed' } }, [], signedBy(alice));
  assert.equal(r.state, 'success');
});

test('signing twice leaves one record and keeps the first signature', () => {
  const args = { signer: alice, comment: { id: 1, url: 'u', createdAt: 't1' }, number: 3, claSha256: 'h', claCommit: 'c' };
  const once = addSignature(null, args);
  assert.equal(once.added, true);
  const twice = addSignature(once.record, { ...args, comment: { id: 2, url: 'v', createdAt: 't2' } });
  assert.equal(twice.added, false);
  assert.equal(twice.record.signatures.length, 1);
  assert.equal(twice.record.signatures[0].signed_at, 't1');
  assert.equal(twice.record.signatures[0].cla_sha256, 'h');
});

test('the failure comment names each missing signer and the phrase, and flags unlinked emails', () => {
  const body = commentBody({ state: 'failure', missing: [alice], unlinked: ['ghost@example.com'], unlistedBots: [], truncated: false }, 'https://cla', 'https://faq');
  assert.match(body, /- \[ \] @alice/);
  assert.ok(body.includes(SIGN_PHRASE));
  assert.match(body, /ghost@example\.com/);
  assert.match(body, /commercial licenses/);
});

// ---- I/O with a fake gh ------------------------------------------------------

function fakeGh({ record = null, branch = record !== null, pr, commits = [], conflicts = 0, otherPrs = [], bigFile = false, ruleViolation = false, openPrs = [] }) {
  const state = { record, sha: record ? 's0' : null, branch, conflicts, calls: [], comments: [], statuses: [], otherPrs, bigFile, ruleViolation, openPrs };
  const ok = (obj) => ({ status: 0, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr: '' });
  const err = (code) => ({ status: 1, stdout: '', stderr: `gh: HTTP ${code}` });
  const spawn = (_cmd, args, opts) => {
    const a = args.slice(1);
    const input = opts.input ? JSON.parse(opts.input) : undefined;
    state.calls.push([a.join(' '), input]);
    const path = a.find((x) => x.startsWith('repos/') || x.startsWith('search/'));
    const method = a.includes('--method') ? a[a.indexOf('--method') + 1] : 'GET';
    if (path.includes(`/contents/${SIGNATURE_PATH}`) && method === 'GET') {
      if (!state.branch || !state.record) return err(404);
      if (state.bigFile) return ok({ sha: state.sha, encoding: 'none', content: '' });
      return ok({ sha: state.sha, encoding: 'base64', content: Buffer.from(JSON.stringify(state.record)).toString('base64') });
    }
    if (path.endsWith('/git/ref/heads/cla-signatures')) return state.branch ? ok({ object: { sha: `head-${state.sha}` } }) : err(404);
    if (/\/git\/blobs\//.test(path)) return ok({ content: Buffer.from(JSON.stringify(state.record)).toString('base64') });
    if (path.startsWith('search/')) return ok({ items: state.otherPrs.map((number) => ({ number })) });
    if (path.endsWith('/git/trees')) return ok({ sha: 'tree1' });
    if (path.endsWith('/git/commits')) return ok({ sha: 'commit1' });
    if (path.endsWith('/git/refs')) {
      state.branch = true;
      state.record = JSON.parse(input.sha === 'commit1' ? state.pendingText : '{}');
      return ok({});
    }
    if (path.includes(`/contents/${SIGNATURE_PATH}`) && method === 'PUT') {
      if (state.ruleViolation) return { status: 1, stdout: '', stderr: 'gh: Repository rule violations found (HTTP 409)' };
      if (state.conflicts > 0) {
        state.conflicts--;
        return { status: 1, stdout: '', stderr: `gh: ${SIGNATURE_PATH} is at abc but expected def (HTTP 409)` };
      }
      state.record = JSON.parse(Buffer.from(input.content, 'base64').toString('utf8'));
      state.sha = `s${state.calls.length}`;
      return ok({});
    }
    if (/\/pulls\?state=open/.test(path)) return ok([state.openPrs.map((number) => ({ number }))]);
    if (/\/pulls\/\d+$/.test(path)) return ok(pr);
    if (/\/pulls\/\d+\/commits/.test(path)) return ok([commits]);
    if (/\/statuses\//.test(path)) {
      state.status = input;
      state.statuses.push([path, input.state]);
      return ok({});
    }
    if (/\/issues\/\d+\/comments/.test(path) && method === 'GET') return ok([state.comments]);
    if (/\/issues\/\d+\/comments$/.test(path) && method === 'POST') {
      state.comments.push({ id: 1, user: { login: 'github-actions[bot]' }, body: input.body });
      return ok({});
    }
    if (/\/issues\/comments\/\d+$/.test(path) && method === 'PATCH') {
      state.comments[0].body = input.body;
      return ok({});
    }
    throw new Error(`unexpected gh call ${method} ${path}`);
  };
  // The tree call carries the file content; remember it for the ref call.
  const wrapped = (cmd, args, opts) => {
    if (args.some((x) => x.endsWith('/git/trees'))) state.pendingText = JSON.parse(opts.input).tree[0].content;
    return spawn(cmd, args, opts);
  };
  return { state, spawn: wrapped };
}

const claText = readFileSync(join(ROOT, 'CLA.md'), 'utf8');
const prOf = (user) => ({ user, state: 'open', head: { sha: 'head1' } });

test('an unsigned contributor gets a failing status and one instruction comment', () => {
  const { state, spawn } = fakeGh({ pr: prOf(alice), commits: [commit(alice)] });
  const opts = { eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 4 } }, repo: REPO, claText, claCommit: 'a'.repeat(40), spawn };
  run(opts);
  run({ ...opts, payload: { action: 'synchronize', pull_request: { number: 4 } } });
  assert.equal(state.status.state, 'failure');
  assert.equal(state.status.context, 'CLA');
  assert.equal(state.comments.length, 1, 'the instruction comment is updated, not repeated');
});

test('the first signature creates the orphan signatures branch, then the PR goes green', () => {
  const { state, spawn } = fakeGh({ pr: prOf(alice), commits: [commit(alice)] });
  const out = run({
    eventName: 'issue_comment',
    payload: { action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 8, body: SIGN_PHRASE, html_url: 'cu', created_at: '2026-11-09T20:00:00Z', user: alice } },
    repo: REPO, claText, claCommit: 'a'.repeat(40), spawn,
  });
  assert.equal(out.signed, 'created');
  const commitCall = state.calls.find(([c]) => c.includes('/git/commits'));
  assert.deepEqual(commitCall[1].parents, [], 'the signatures branch shares no history with main');
  assert.equal(state.record.signatures[0].github_id, 101);
  assert.equal(state.record.signatures[0].cla_commit, 'a'.repeat(40));
  assert.equal(state.status.state, 'success');
});

test('a concurrent write is retried on top of the newer record', () => {
  const { state, spawn } = fakeGh({ record: signedBy(bob), pr: prOf(alice), conflicts: 2 });
  const outcome = recordSignature(
    (args, input) => {
      const r = spawn('gh', ['api', ...args], { input: input === undefined ? undefined : JSON.stringify(input) });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    REPO,
    { signer: alice, comment: { id: 1, url: 'u', createdAt: 't' }, number: 4, claSha256: 'h', claCommit: 'c' },
  );
  assert.equal(outcome.outcome, 'updated');
  assert.deepEqual(state.record.signatures.map((s) => s.login), ['bob', 'alice']);
});

test('automation pull requests get a green status and no comment', () => {
  const { state, spawn } = fakeGh({ pr: prOf({ id: 49699333, login: 'dependabot[bot]', type: 'Bot' }), commits: [commit({ id: 49699333, login: 'dependabot[bot]', type: 'Bot' })] });
  run({ eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 5 } }, repo: REPO, claText, claCommit: 'b'.repeat(40), spawn });
  assert.equal(state.status.state, 'success');
  assert.equal(state.comments.length, 0);
});

// ---- review findings ---------------------------------------------------------

test('a pull request opened by a bot that is not on the exempt list fails instead of passing unsigned', () => {
  const r = evaluate({ user: { id: 7, login: 'renovate[bot]', type: 'Bot' } }, [commit(null, 'bot@example.com')], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.unlistedBots, ['renovate[bot]']);
});

test('commits from unlinked emails block until an offline signature covers the email', () => {
  const pr = { user: alice };
  const commits = [commit(alice), commit(null, 'Someone@Corp.com')];
  assert.equal(evaluate(pr, commits, signedBy(alice)).state, 'failure');
  const withOffline = { ...signedBy(alice), offline: [{ email: 'someone@corp.com', route: 'pdf' }] };
  assert.equal(evaluate(pr, commits, withOffline).state, 'success');
});

test('an email or PDF signature recorded by a maintainer counts for that account', () => {
  const record = { cla_version: CLA_VERSION, signatures: [], offline: [{ github_id: bob.id, route: 'email' }] };
  assert.equal(evaluate({ user: bob }, [commit(bob)], record).state, 'success');
});

test('a pull request with more commits than GitHub lists fails because their authors are invisible', () => {
  const commits = Array.from({ length: 250 }, () => commit(alice));
  const r = evaluate({ user: alice, commits: 251 }, commits, signedBy(alice));
  assert.equal(r.state, 'failure');
  assert.equal(r.truncated, true);
  assert.equal(evaluate({ user: alice, commits: 250 }, commits, signedBy(alice)).state, 'success', 'exactly 250 are all visible');
});

test('a fully signed pull request gets a green status and no comment', () => {
  const { state, spawn } = fakeGh({ record: signedBy(alice), pr: prOf(alice), commits: [commit(alice)] });
  run({ eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 4 } }, repo: REPO, claText, claCommit: 'c'.repeat(40), spawn });
  assert.equal(state.status.state, 'success');
  assert.equal(state.comments.length, 0);
});

test('signing turns the signer\'s other open pull requests green as well', () => {
  const { state, spawn } = fakeGh({ record: signedBy(bob), pr: prOf(alice), commits: [commit(alice)], otherPrs: [4, 11] });
  const out = run({
    eventName: 'issue_comment',
    payload: { action: 'created', issue: { number: 4, pull_request: {} }, comment: { id: 8, body: SIGN_PHRASE, html_url: 'cu', created_at: 't', user: alice } },
    repo: REPO, claText, claCommit: 'd'.repeat(40), spawn,
  });
  assert.deepEqual(out.alsoChecked, [11]);
  assert.deepEqual(state.statuses.map(([, s]) => s), ['success', 'success']);
});

test('a signatures file over 1 MB is read through the blob API', () => {
  const { spawn } = fakeGh({ record: signedBy(alice), pr: prOf(alice), commits: [commit(alice)], bigFile: true });
  const out = run({ eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 4 } }, repo: REPO, claText, claCommit: 'e'.repeat(40), spawn });
  assert.equal(out.result.state, 'success');
});

test('commits under the LTplus release-bot user account need no signature', () => {
  const r = evaluate({ user: alice }, [commit({ id: 335935680, login: 'ifc-lite-release-bot', type: 'User' })], signedBy(alice));
  assert.equal(r.state, 'success');
});

test('commits by an app account that is not on the exempt list block the check', () => {
  const r = evaluate({ user: alice }, [commit(alice), commit({ id: 9, login: 'some-app[bot]', type: 'Bot' })], signedBy(alice));
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.unlistedBots, ['some-app[bot]']);
});

test('a GitHub signature added to a record holding only offline entries keeps them', () => {
  const seeded = { cla_version: CLA_VERSION, offline: [{ github_id: bob.id, route: 'pdf' }] };
  const { record } = addSignature(seeded, { signer: alice, comment: { id: 1, url: 'u', createdAt: 't' }, number: 2, claSha256: 'h', claCommit: 'c' });
  assert.deepEqual(record.offline, seeded.offline);
  assert.deepEqual(record.signatures.map((x) => x.login), ['alice']);
});

test('a comment that cannot be written does not undo the status already set', () => {
  const { state, spawn } = fakeGh({ pr: prOf(alice), commits: [commit(alice)] });
  const failingComments = (cmd, args, opts) => {
    if (args.some((x) => /\/issues\/\d+\/comments$/.test(x)) && args.includes('POST')) return { status: 1, stdout: '', stderr: 'gh: HTTP 403' };
    return spawn(cmd, args, opts);
  };
  const out = run({ eventName: 'pull_request_target', payload: { action: 'opened', pull_request: { number: 4 } }, repo: REPO, claText, claCommit: 'f'.repeat(40), spawn: failingComments });
  assert.equal(out.result.state, 'failure');
  assert.equal(state.status.state, 'failure');
});

test('exemptions follow the account id, so a new account that takes a freed LTplus login must sign', () => {
  const impostor = { id: 999, login: 'louistrue', type: 'User' };
  const r = evaluate({ user: impostor }, [], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing.map((u) => u.id), [999]);
});

test('human commits pushed onto a dependency-bot pull request still need a signature', () => {
  const r = evaluate({ user: { id: 49699333, login: 'dependabot[bot]', type: 'Bot' } }, [commit(bob)], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing.map((u) => u.login), ['bob']);
});

test('a hand-edited record with a non-array field is refused with a clear reason', () => {
  assert.throws(() => evaluate({ user: alice }, [], { offline: {} }), (e) => e instanceof ClaGateError && e.reason === 'BAD_RECORD');
});

test('a write refused by a repository rule fails loudly instead of being retried as a race', () => {
  const { spawn } = fakeGh({ record: signedBy(bob), pr: prOf(alice), ruleViolation: true });
  assert.throws(() => recordSignature(
    (args, input) => spawn('gh', ['api', ...args], { input: input === undefined ? undefined : JSON.stringify(input) }),
    REPO,
    { signer: alice, comment: { id: 1, url: 'u', createdAt: 't' }, number: 4, claSha256: 'h', claCommit: 'c' },
  ), (e) => e instanceof ClaGateError && e.reason === 'GH_FAILED' && /rule/i.test(e.message));
});

test('a commit with neither a linked account nor an email blocks the check', () => {
  const r = evaluate({ user: alice }, [commit(alice), { author: null, commit: { author: { email: '' } } }], signedBy(alice));
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.unlinked, ['(no email)']);
});

test('commit emails cannot inject markup or mentions into the bot comment', () => {
  const evil = 'x`[sign here](https://evil.example) @maintainer`@a.b';
  const body = commentBody({ state: 'failure', missing: [], unlinked: [evil], unlistedBots: [], truncated: false }, 'c', 'f');
  const line = body.split('\n').find((l) => l.startsWith('- `'));
  assert.equal((line.match(/`/g) ?? []).length, 2, 'exactly one code span');
  assert.ok(line.startsWith('- `') && line.endsWith('`'), 'everything stays inside it');
  assert.doesNotMatch(line, /[[\]\n]/);
});

test('a manual run gives every open pull request a status', () => {
  const { state, spawn } = fakeGh({ record: signedBy(alice), pr: prOf(alice), commits: [commit(alice)], openPrs: [4, 5, 6] });
  const out = run({ eventName: 'workflow_dispatch', payload: {}, repo: REPO, claText, claCommit: '1'.repeat(40), spawn });
  assert.deepEqual(out.alsoChecked, [4, 5, 6]);
  assert.equal(state.statuses.length, 3);
});

// ---- co-author trailers ------------------------------------------------------

test('a co-author named by a GitHub noreply address must sign, even on a maintainer commit', () => {
  const msg = 'feat: x\n\nCo-authored-by: Alice A <101+alice@users.noreply.github.com>';
  const r = evaluate({ user: louis }, [commit(louis, 'l@x', msg)], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.missing.map((u) => u.id), [101]);
  assert.equal(evaluate({ user: louis }, [commit(louis, 'l@x', msg)], signedBy(alice)).state, 'success');
});

test('AI assistants, LTplus addresses and named bots as co-authors need no signature', () => {
  const msg = [
    'Co-authored-by: Claude <noreply@anthropic.com>',
    'co-authored-by: Codex <noreply@openai.com>',
    'Co-authored-by: L <78563314+louistrue@users.noreply.github.com>',
    'Co-authored-by: L <louistrue@users.noreply.github.com>',
    'Co-authored-by: L <Louis@LT.plus>',
    'Co-authored-by: gha <41898282+github-actions[bot]@users.noreply.github.com>',
  ].join('\n');
  assert.equal(evaluate({ user: louis }, [commit(louis, 'l@x', `x\n\n${msg}`)], signedBy()).state, 'success');
});

test('a co-author with another email blocks until an offline signature covers that email', () => {
  const c = commit(louis, 'l@x', 'x\n\nCo-authored-by: Someone <Someone@Corp.com>');
  const r = evaluate({ user: louis }, [c], signedBy());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.coauthorEmails, ['someone@corp.com']);
  assert.match(commentBody(r, 'c', 'f'), /Co-authored-by/);
  assert.equal(evaluate({ user: louis }, [c], { ...signedBy(), offline: [{ email: 'someone@corp.com' }] }).state, 'success');
});

test('co-author parsing reads trailer lines only and an id-less noreply address by login', () => {
  assert.deepEqual(coAuthors('mention Co-authored-by: X <x@y.z> inline\nCo-authored-by: Bob <bob@users.noreply.github.com>'),
    [{ user: { id: undefined, login: 'bob', type: 'User' } }]);
  const r = evaluate({ user: louis }, [commit(louis, 'l@x', 'x\n\nCo-authored-by: Bob <bob@users.noreply.github.com>')], signedBy(bob));
  assert.equal(r.state, 'success', 'an id-less co-author matches the signature by login');
});
