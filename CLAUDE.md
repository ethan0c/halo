# Halo

Screen-share-invisible AI overlay (Electron + Claude + local Whisper). Read `README.md` for usage and `docs/architecture.md` before changing anything structural.

## Commands

- `npm start` builds and launches. `npm run dev` launches with content protection off (for screenshots). `npm run smoke` is the headless load check; run it after renderer changes. `npm run icons` regenerates PNG icons from the logo geometry. `npm run dist` builds `Halo.app`.
- From an editor-spawned shell, prefix Electron commands with `env -u ELECTRON_RUN_AS_NODE`.

## Conventions

- Main process is CommonJS, renderer is ESM bundled by esbuild into `dist/` (git-ignored). Never load anything in the renderer from `file://` or a CDN; add it to the bundle or serve it through the `app://` handler in `src/main/main.js`.
- The API key stays in the main process. Add new privileged operations as IPC handlers in `main.js` and expose them through `src/preload.js`; never widen `webPreferences`.
- Claude calls go through `src/main/claude.js` using `@anthropic-ai/sdk`. Default model is `claude-opus-5-5`; interview suggestions use `effort: low`. Keep `fallbacks: 'default'` with the `server-side-fallback-2026-07-01` beta on 5.5-family models.
- Design is monochrome liquid glass: whites, silvers, translucent blacks, Geist Variable. No colour accents. Keep the bar 48 px tall; the window height follows `#app` via `ResizeObserver`.
- Settings are a flat object in `src/main/config.js`; add a default there and it flows through `getPublic()`/`update()` automatically. Shortcuts default to `⌘⇧` + H/C/L/M and are user-configurable; the renderer displays them via `accelLabel()` and records new ones via `accelFromEvent()` in `app.js`.
- Resume and job description files are parsed locally in `src/main/documents.js`; never upload the raw file to the API.
- The logo lives in two places that must match: `src/renderer/logo.js` (SVG) and `scripts/make-icons.mjs` (rasteriser).
