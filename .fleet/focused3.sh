#!/usr/bin/env bash
# Ordinary job: install, build the viewer, typecheck viewer + parser, focused unit tests, parser spare tests, module size.
set -uo pipefail
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
echo "source commit: $(git rev-parse HEAD)"
pnpm install --frozen-lockfile --prefer-offline >/dev/null || { echo INSTALL_FAILED; exit 2; }
pnpm exec turbo build --filter=@ifc-lite/viewer --output-logs=errors-only >${TMPDIR:-/tmp}/build-9900r.log 2>&1 || { echo VIEWER_BUILD_FAILED; tail -30 ${TMPDIR:-/tmp}/build-9900r.log; exit 2; }
echo "VIEWER BUILD ok"
rc=0
(cd apps/viewer && pnpm exec tsc --noEmit -p .) > ${TMPDIR:-/tmp}/tsc-9900r.log 2>&1; t=$?; echo "TSC viewer exit $t"; [ $t -ne 0 ] && { head -30 ${TMPDIR:-/tmp}/tsc-9900r.log; rc=1; }
(cd packages/parser && pnpm exec tsc --noEmit -p .) > ${TMPDIR:-/tmp}/tscp-9900r.log 2>&1; t=$?; echo "TSC parser exit $t"; [ $t -ne 0 ] && { head -30 ${TMPDIR:-/tmp}/tscp-9900r.log; rc=1; }
(cd packages/parser && pnpm exec vitest run src/spare-parser-worker.test.ts src/worker-parser) > ${TMPDIR:-/tmp}/vp-9900r.log 2>&1; t=$?; echo "PARSER TESTS exit $t"; grep -E "Tests |Test Files" ${TMPDIR:-/tmp}/vp-9900r.log; [ $t -ne 0 ] && { tail -40 ${TMPDIR:-/tmp}/vp-9900r.log; rc=1; }
(cd apps/viewer && TEST_PATTERN='fast-path|fastPath|pickStart|stepSource|useIfcLoader|useGeometryStreaming|scene-settled|spatial-index|location-map|modelLoadedGeometryProps' pnpm test) > ${TMPDIR:-/tmp}/test-9900r.log 2>&1; t=$?; echo "VIEWER TESTS exit $t"
grep -E '^. (tests|pass|fail|skipped|cancelled) [0-9]+$' ${TMPDIR:-/tmp}/test-9900r.log; [ $t -ne 0 ] && { grep -E '^✖|not ok' ${TMPDIR:-/tmp}/test-9900r.log | head -30; rc=1; }
node scripts/check-module-size.mjs --base origin/main > ${TMPDIR:-/tmp}/ms-9900r.log 2>&1; echo "MODULE_SIZE exit $?"; tail -1 ${TMPDIR:-/tmp}/ms-9900r.log
grep -c "small-file-fast-path" playwright.config.ts; exit $rc
