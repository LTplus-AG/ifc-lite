# SPDX-License-Identifier: MPL-2.0
# Verbatim workflow run body follows; fixture results exclude these comments.
failed=0
for lane in NATIVE_CTEST NATIVE_CONSUMERS WASM_CTEST BROWSER_RUNTIME BROWSER_PROCESSING BROWSER_API GENERATED_TYPES BROWSER_JS; do
  printf '%s=%s\n' "$lane" "${!lane}"
  if [[ "${!lane}" != success ]]; then failed=1; fi
done
exit "$failed"
