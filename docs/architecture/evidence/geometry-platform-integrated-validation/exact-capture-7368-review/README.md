<!-- SPDX-License-Identifier: MPL-2.0 -->
# Exact-route capture review

Source `7368cb32e9` is not integrated or qualified. Review confirms the pinned pre-common-program base `772522f9df` and full raw-field serializer direction, but requests changes before A/B execution: authenticate commit/tree/blob contents against actual fleet receipts; account for all effective compiler/profile overrides; reject mismatched options and jointly incomplete captures. Equality of two invalid captures cannot establish preservation.

The child is repairing these findings in a separate increment. All actual captures, baseline/branch identity, federation and nonempty instancing coverage remain unverified. No no-regression verdict is implied.
