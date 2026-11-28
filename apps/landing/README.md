# IFClite landing page

Static landing page for IFClite. Plain HTML/CSS/JS: the page itself needs no
build step. The deployed site also carries the MkDocs documentation under
`/docs/` (see Deploy).

## Files

- `index.html` — page markup, theme-init + theme-toggle scripts, iso-grid parallax
- `styles.css` — design system + all section styles (`paper` and `dusk` themes)
- `app.jsx` — React widgets (code tabs, package picker, bench explorer, stack
  builder), compiled in the browser by Babel standalone
- `assets/logo.png` — IFClite mark
- `bench-data.json` — source of truth for the benchmark rows in `app.jsx` and
  `index.html`; regenerate those rows with `pnpm docs:generate`, never by hand
- `samples/` — the hello-wall sample files the `app.jsx` widgets load and link
- `build-docs.sh` — the Vercel build (see Deploy)
- `vercel.json` — Vercel project settings and response headers

## Theme

Light (`paper`) and dark (`dusk`) themes are driven by `<html data-theme>`. The
toggle in the nav persists the choice to `localStorage` (`ifclite-theme`); first
visit follows the OS `prefers-color-scheme`. Type is IBM Plex Sans / Serif with
JetBrains Mono for code.

## Local preview

Serve the folder over HTTP (the React/Babel CDN scripts need a real origin):

```sh
npx serve apps/landing
```

## Deploy

Ships as a separate Vercel project with root directory `apps/landing`.
`vercel.json` sets the build command `bash build-docs.sh` and the output
directory `dist`. The script copies this folder into `dist/`, builds the API
reference (`docs:api`) from the locked workspace, and builds the MkDocs site
from the repository's `mkdocs.yml` into `dist/docs/`. Run it locally with
`bash apps/landing/build-docs.sh`, then serve `apps/landing/dist`. The folder is
not a pnpm/turbo workspace package — it has no `package.json` on purpose.

## Origin

Recreated from a Claude Design handoff bundle. Benchmark numbers come from
`bench-data.json`, whose methodology and raw runs are in
[louistrue/profiling@apples-to-apples-with-native](https://github.com/louistrue/profiling/tree/apples-to-apples-with-native).
