#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel "ignored build step" for the ifclite.dev project. Exit 0 skips
# the build, any other exit builds.
#
# HEAD^..HEAD is exact here because main only advances by squash merges
# (one commit per PR), so the tip commit IS the whole delta of a push.
# If that merge policy ever changes to merge commits or multi-commit
# pushes, widen this to the push range.
#
# Fail-open: if git errors for any reason (shallow clone edge cases,
# missing parent), the non-zero exit means "build", never "skip".

git diff --quiet HEAD^ HEAD -- . ../../docs ../../mkdocs.yml ../../requirements-docs.txt
