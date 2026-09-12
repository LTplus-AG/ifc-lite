/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build-profile verification for scripts/check-server-bin-targets.mjs.
 *
 * The published server binaries must unwind on panic. apps/server parses
 * attacker-supplied IFC bytes for every tenant in one process and wraps its
 * router in `CatchPanicLayer`; that layer, and the `spawn_blocking` isolation
 * behind it, are both inert under the repo-root `[profile.release]`
 * `panic = 'abort'` - the process aborts before either can run. Only
 * `[profile.server-release]` (inherits release, `panic = "unwind"`) satisfies
 * the precondition, which is why apps/server/Dockerfile has always used it.
 *
 * The release pipeline did not: every `Build Server Binary` step passed
 * `--release` and the archives were copied out of `target/<triple>/release/`,
 * so the GitHub release assets and the npm `@ifc-lite/server-bin` package
 * shipped an aborting binary while the source comment claimed otherwise.
 *
 * Two teeth, because they fail differently:
 *
 *   1. Every `cargo build` / `cross build` in a `Build Server Binary` step
 *      must pass `--profile server-release` and must not pass `--release`,
 *      and every `target/${{ matrix.rust-target }}/<profile>/` path in the
 *      workflow must name `server-release`. A wrong flag ships an aborting
 *      binary; a wrong copy path ships nothing (or, worse, a stale binary
 *      from an earlier profile directory).
 *   2. The jobs whose runners can EXECUTE what they built must keep their
 *      "Assert the built binary unwinds" step, which runs the artefact with
 *      `--panic-strategy-selftest`. That is the behavioural check; this
 *      module is the textual one, and a textual check that can be satisfied
 *      while the behavioural one is deleted is worth much less.
 *
 * Input is comment-stripped by the caller (see server-bin-targets-parse.mjs),
 * so a commented-out build line counts as absent rather than as compliant.
 * Executable proof: scripts/check-server-bin-targets.test.mjs.
 */

import { fail, jobBlock, sliceStep } from './server-bin-targets-parse.mjs';

/** The only profile whose binaries unwind (repo-root Cargo.toml). */
export const REQUIRED_PROFILE = 'server-release';

const BUILD_STEP = 'Build Server Binary';
const ASSERT_STEP = 'Assert the built binary unwinds';
const SELFTEST_FLAG = '--panic-strategy-selftest';
// The comparison that makes the step fail on an aborting binary. A text gate
// cannot prove the binary ran; this line, executed in CI, is what does, so the
// gate pins it rather than modelling shell quoting around the invocation.
const SELFTEST_VERDICT = 'test "$verdict" = "panic-strategy: unwind"';
const PROFILE_BINARY = `${REQUIRED_PROFILE}/ifc-lite-server`;
const WINDOWS_BINARY_SUFFIX = 'bin="$' + '{bin}.exe"';
const RELEASE_SELFTEST_SOURCE_GUARD = new RegExp(
  `^\\s*if grep -Fq -- '${SELFTEST_FLAG}' apps/server/src/panic_strategy\\.rs 2>/dev/null; then\\s*$`,
  'm',
);
/** The release job's archive steps, each of which must copy the built binary. */
const ARCHIVE_STEPS = ['Prepare Binary (Unix)', 'Prepare Binary (Windows)'];
/** Release legs whose output can execute natively on the matrix runner. */
const RELEASE_SELFTEST_TARGETS = ['linux-x64', 'linux-x64-musl', 'darwin-arm64', 'win32-x64'];

/** Every job that builds a server binary. */
const BUILD_JOBS = [
  'validate-server-binaries',
  'validate-server-binaries-cross',
  'release-server-binaries',
];

/**
 * Jobs whose runner executes at least one leg's own output, so they can carry
 * the behavioural assertion. `validate-server-binaries-cross` cannot: its
 * aarch64 leg cannot run on an x64 runner, and its musl leg only builds there
 * (the release job's musl leg does run the assertion: a static x86_64 binary
 * executes natively however it was built).
 */
const SELFTEST_JOBS = ['validate-server-binaries', 'release-server-binaries'];

/**
 * `cargo build` / `cross build` invocations in a step, with their argument
 * text. Leading `VAR=value` assignments (CARGO_UNSTABLE_BUILD_STD) are
 * skipped over rather than parsed: the crate list is not the panic strategy.
 */
function buildInvocations(step) {
  return [...step.matchAll(/^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*(cargo|cross)[ \t]+build[ \t]+([^\n]*)$/gm)]
    .map(([, tool, args]) => ({ tool, args: args.trim() }));
}

/**
 * The workflow must build and archive the unwinding profile, everywhere.
 */
export function checkUnwindProfile(workflow, origin) {
  for (const job of BUILD_JOBS) {
    const body = jobBlock(workflow, job, origin);
    const step = sliceStep(body, BUILD_STEP);
    if (step === null) {
      fail(
        `cannot find the "${BUILD_STEP}" step in job "${job}" of ${origin}; if it was renamed, ` +
        `update this check - it must not pass without pinning the build profile`,
      );
    }
    const builds = buildInvocations(step);
    if (builds.length === 0) {
      fail(
        `the "${BUILD_STEP}" step in job "${job}" of ${origin} runs no cargo/cross build command; ` +
        `refusing a vacuous pass - a commented-out build line counts as absent here. Restore an ` +
        `active cargo build or cross build --profile ${REQUIRED_PROFILE} command in that step`,
      );
    }
    for (const { tool, args } of builds) {
      if (/(^|\s)--release(\s|$)/.test(args)) {
        fail(
          `"${tool} build" in job "${job}" of ${origin} passes --release; the repo-root ` +
          `[profile.release] sets panic = 'abort', which makes CatchPanicLayer in ` +
          `apps/server/src/main.rs inert - one malformed IFC upload then aborts the whole ` +
          `multi-tenant process. Build with --profile ${REQUIRED_PROFILE}`,
        );
      }
      if (!new RegExp(`(^|\\s)--profile[ \\t]+${REQUIRED_PROFILE}(\\s|$)`).test(args)) {
        fail(
          `"${tool} build" in job "${job}" of ${origin} does not pass ` +
          `--profile ${REQUIRED_PROFILE}; only that profile unwinds, and an aborting server ` +
          `binary dies on the first malformed upload instead of returning 500 for it`,
        );
      }
    }
  }

  // Artifact paths: the profile directory the archives are copied from (and
  // the self-test runs) must be the one that was built.
  // The ${{ }} below is a GitHub Actions expression matched as text.
  // eslint-disable-next-line no-template-curly-in-string
  const paths = [...workflow.matchAll(/target\/\$\{\{[ \t]*matrix\.rust-target[ \t]*\}\}\/([A-Za-z0-9_.-]+)\//g)];
  if (paths.length < 2) {
    fail(
      `found ${paths.length} "target/<rust-target>/<profile>/" path(s) in ${origin}; the archive ` +
      `copy steps must read the built binary out of a profile directory - refusing a vacuous pass`,
    );
  }
  for (const [match, profile] of paths) {
    if (profile !== REQUIRED_PROFILE) {
      fail(
        `${origin} reads "${match}", but the binaries are built with ` +
        `--profile ${REQUIRED_PROFILE}, so the archived bytes must come from ` +
        `target/<rust-target>/${REQUIRED_PROFILE}/`,
      );
    }
  }

  // The workflow-wide scan above cannot tell WHICH job a path came from, so a
  // release job whose archive steps stopped reading the profile directory
  // would still pass on the self-test's path. Each archive step must copy the
  // binary out of the required profile.
  const release = jobBlock(workflow, 'release-server-binaries', origin);
  for (const name of ARCHIVE_STEPS) {
    const step = sliceStep(release, name);
    if (step === null || !step.includes(PROFILE_BINARY)) {
      fail(
        `the "${name}" step of job "release-server-binaries" in ${origin} does not copy ` +
        `target/<rust-target>/${PROFILE_BINARY}; the archived bytes must be the unwinding build`,
      );
    }
  }

  // The behavioural assertion itself.
  for (const job of SELFTEST_JOBS) {
    const step = sliceStep(jobBlock(workflow, job, origin), ASSERT_STEP);
    if (
      step === null ||
      !step.includes(SELFTEST_FLAG) ||
      !step.includes(PROFILE_BINARY) ||
      !step.includes(SELFTEST_VERDICT)
    ) {
      fail(
        `job "${job}" of ${origin} has no "${ASSERT_STEP}" step running the built binary ` +
        `(${PROFILE_BINARY}) with ${SELFTEST_FLAG} and checking ${SELFTEST_VERDICT}; that ` +
        `step is the only check that reads the ARTEFACT's panic strategy rather than the ` +
        `flags meant to produce it`,
      );
    }
  }

  const releaseSelftest = sliceStep(release, ASSERT_STEP);
  for (const target of RELEASE_SELFTEST_TARGETS) {
    if (releaseSelftest === null || !releaseSelftest.includes(`matrix.target == '${target}'`)) {
      fail(
        `the "${ASSERT_STEP}" step of job "release-server-binaries" in ${origin} does not run ` +
        `for native target "${target}"; every release artefact executable on its matrix runner ` +
        `must prove that it unwinds`,
      );
    }
  }
  if (releaseSelftest === null || !releaseSelftest.includes(WINDOWS_BINARY_SUFFIX)) {
    fail(
      `the "${ASSERT_STEP}" step of job "release-server-binaries" in ${origin} does not select ` +
      `the .exe path on Windows; the win32-x64 behavioural check must execute the built artefact`,
    );
  }
  if (releaseSelftest === null || !RELEASE_SELFTEST_SOURCE_GUARD.test(releaseSelftest)) {
    fail(
      `the "${ASSERT_STEP}" step of job "release-server-binaries" in ${origin} does not guard ` +
      `the behavioural flag on checked-out source support; workflow_dispatch upload-to-tag ` +
      `backfills can build an older binary that ignores ${SELFTEST_FLAG} and starts the server, ` +
      `hanging the release job instead of reaching upload; restore the active ` +
      `if grep -Fq -- '${SELFTEST_FLAG}' ...; then check before the self-test`,
    );
  }
}
