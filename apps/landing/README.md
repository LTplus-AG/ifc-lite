# IFClite landing page

Static landing / docs page for IFClite. Plain HTML/CSS/JS — no build step.

## Files

- `index.html` — page markup, theme-init + theme-toggle scripts, iso-grid parallax
- `styles.css` — design system + all section styles (`paper` and `dusk` themes)
- `app.jsx` — React widgets (code tabs, package picker, bench explorer, stack
  builder), compiled in the browser by Babel standalone
- `assets/logo.png` — IFClite mark

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

Intended to ship as a separate Vercel project: a static site with no build
command and output directory `apps/landing`. Not wired into the pnpm/turbo
workspace — it has no `package.json` on purpose.

## Origin

Recreated from a Claude Design handoff bundle. Benchmark numbers come from
[louistrue/profiling@apples-to-apples-with-native](https://github.com/louistrue/profiling/tree/apples-to-apples-with-native).
