SPDX-License-Identifier: MPL-2.0
#7955 B2b Boolean source origins

These are independent regression mutations using the existing revert-oracle
workflow. They change production behavior, never the observers or private types.
operator-action permits an authored clipping UNION; predicate-report refuses but
drops the typed predicate fact; core-report refuses but drops the owned Core
payload. Each must compile, fail an intended behavioral assertion, restore, and
pass the same tests before a mutation kill can be claimed.

Prepared only: no local mutation execution is claimed. The existing test.yml
step invokes each input separately and repeats the restored controller tests.
Historical patches are preserved unchanged. These inline STEP tests exercise
logical request/admit/accept/finish behavior and exact compatibility controls,
not retained SDK geometry or complete #7955 coverage.
