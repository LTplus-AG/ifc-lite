# Generated public API reference

Reproduce from the repository root:

```sh
pnpm install --frozen-lockfile
node --test scripts/docs/build-api-reference.test.mjs
node tests/evidence/api-reference/capture.mjs
bash apps/landing/build-docs.sh
```

The landing build requires Python with venv support. This run used the host's
installed Python 3.12. The complete production build passed strict MkDocs and
copied the generated API pages and search assets into the landing deployment.

`receipt.json` records actual generated package/subpath coverage and representative
symbol pages. The generated HTML stays ignored and is rebuilt in CI and deployment.

`search.png` is a native T3 browser capture after searching for `openModel`.
`open-model.png` shows the function signature and its session return type after
following the result. The session page also displayed `report`, `capability`, and
`close`. No browser viewer or GPU was involved.

`wasm-free.json` records a second run from a fresh checkout with no built
WASM runtime and no `wasm-pack` on PATH. All package declarations and the full
reference were generated from scratch, using the committed WASM types.
