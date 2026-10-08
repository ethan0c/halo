# Halo

Screen-share-invisible AI overlay (Electron + Claude + local Whisper). Read `README.md` for usage and `docs/architecture.md` before changing anything structural.

## Commands

- `npm start` builds and launches. `npm run dev` launches with content protection off (for screenshots). `npm run smoke` is the headless load check; run it after renderer changes. `npm run icons` regenerates PNG icons from the logo geometry. `npm run dist` builds `Halo.app`.
- From an editor-spawned shell, prefix Electron commands with `env -u ELECTRON_RUN_AS_NODE`.

## Conventions

- Main process is CommonJS, renderer is ESM bundled by esbuild into `dist/` (git-ignored). Never load anything in the renderer from `file://` or a CDN; add it to the bundle or serve it through the `app://` handler in `src/main/main.js`.
- The API key stays in the main process. Add new privileged operations as IPC handlers in `main.js` and expose them through `src/preload.js`; never widen `webPreferences`.
- Claude calls go through `src/main/claude.js` using `@anthropic-ai/sdk`. Default model is `claude-opus-5-5`; interview suggestions use `effort: low`. Keep `fallbacks: 'default'` with the `server-side-fallback-2026-07-01` beta on 5.5-family models.
- Design is monochrome liquid glass: whites, silvers, translucent blacks, Geist Variable. No colour accents. Every colour is a CSS token defined twice (`:root` dark glass, `[data-theme="light"]` light glass); never hard-code a colour in a rule. The theme comes from main (`backdrop.js` sampling or the `themeMode` setting), and the tint opacity `--glass-a` follows the sampled luminance. Do not add macOS window vibrancy; it bleeds the backdrop through and kills contrast on white pages. `HALO_SHOT=<dir> npm run smoke` renders the UI on white, black and grey into that directory for contrast checks.
- Thinking state is `#app.thinking`: the `.halo-spin` group in the logo rotates and the answer shows skeleton lines. Never animate `transform` on `.halo-ring` itself; it carries a static SVG rotation.
- `build.mjs` copies every `ort-wasm-simd-threaded*` file from onnxruntime-web into `dist/ort/`; transformers.js picks the variant at runtime, so do not trim that list. Keep the bar 48 px tall. The window follows the content: height from `#app`, width from `neededWidth()` in `app.js` with the preset width as a floor. Adding a control to the bar needs no width constant change; `npm run smoke` prints `barFits` and per-preset `SMOKE fit` lines under `HALO_SHOT`, check them.
- Settings are a flat object in `src/main/config.js`; add a default there and it flows through `getPublic()`/`update()` automatically. Shortcuts default to `⌘⇧` + H/C/L/M and are user-configurable; the renderer displays them via `accelLabel()` and records new ones via `accelFromEvent()` in `app.js`.
- The window is non-activating by default (`keepFocus`). Any new text input must call `halo.focusInput()` on mousedown and `halo.releaseFocus()` when done; never call `win.focus()` from main except through `grabFocusForTyping()`. Do not add anything that synthesises keyboard or mouse input.
- Presets are `talk` and `code`; their differences live in `WIDTHS`/`PRESET_DOCK` in `main.js`, `TALK_PRESET`/`CODE_PRESET` in `claude.js`, and `autoSuggestOn()` in `app.js`. Add a third only if it differs in all three.
- Audio inputs are separate channels (`attachStream(stream, label, speaker)`); never mix streams into one node, the speaker labels depend on it. Any denoiser goes between the source and the PCM worklet inside `attachStream`.
- In listen mode, never blank the answer panel: pass `keep: true` to `ask()` so the previous answer stays until the new one streams. Auto-suggest is gated by `looksLikeQuestion()`; tune the heuristic there rather than lowering the pause.
- Resume and job description files are parsed locally in `src/main/documents.js`; never upload the raw file to the API.
- The logo lives in two places that must match: `src/renderer/logo.js` (SVG) and `scripts/make-icons.mjs` (rasteriser).
