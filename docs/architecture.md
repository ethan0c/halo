# Architecture

Halo is a two-process Electron app. The main process owns everything privileged (window flags, screen capture, the API key, Claude calls). The renderer owns the UI and the local speech pipeline. They talk over a small IPC bridge exposed by `src/preload.js`.

```
┌──────────────────────────── main process ─────────────────────────────┐
│ main.js      window, tray, shortcuts, app:// protocol, IPC routing     │
│ capture.js   desktopCapturer → JPEG ≤1568px of the display under cursor│
│ claude.js    @anthropic-ai/sdk streaming, system prompts, error mapping │
│ config.js    halo.json in userData, API key via safeStorage            │
└───────────────▲──────────────────────────────┬────────────────────────┘
                │ ipcRenderer.invoke / send     │ webContents.send('claude:event')
┌───────────────┴──────────────────────────────▼───── renderer ─────────┐
│ app.js       UI state, capture flow, interview flow, settings          │
│ worker.js    transformers.js Whisper pipeline (WebGPU → WASM fallback) │
│ pcm-worklet  AudioWorklet that streams 16 kHz mono PCM to app.js       │
└───────────────────────────────────────────────────────────────────────┘
```

## Why these choices

**Electron, not Swift.** The one OS feature that matters, hiding from screen capture, is a single call (`win.setContentProtection(true)`, which sets `NSWindow.sharingType = .none`). Electron exposes it directly and also gives us WebGPU for local Whisper, so there is no native code to maintain.

**`app://` instead of `file://`.** Pages loaded from `file://` have an opaque origin: no Cache API, no `fetch`, limited workers. transformers.js caches model weights in the Cache API, so the renderer is served from a privileged custom scheme (`protocol.registerSchemesAsPrivileged` + `protocol.handle` in `main.js`). The handler also sets COOP/COEP headers so `crossOriginIsolated` is true and ONNX Runtime can use threads.

**Key stays in main.** The renderer never sees the API key. It sends message arrays; main attaches credentials, streams the response, and forwards `delta` / `done` / `error` / `aborted` events tagged with a request id. The renderer ignores events for stale ids, so a newer request cleanly supersedes an older one.

**Local transcription.** Anthropic has no speech endpoint, and adding a second vendor key was out. Whisper via transformers.js runs in a Web Worker with the weights fetched once from Hugging Face and cached. WebGPU is tried first, WASM second.

**No framework, one bundler step.** The UI is plain DOM code. esbuild bundles `app.js`, `worker.js` and the Geist font into `dist/` in well under a second. `npm start` always rebuilds.

## Capture flow

1. `runCapture(question)` in `app.js` asks main for a screenshot. `capture.js` finds the display under the cursor, captures it at native resolution, downsizes to a 1568 px long edge (Claude's effective maximum) and returns base64 JPEG.
2. The screenshot and the question become one user turn in `convo`. Older turns keep at most two images (`trimOldScreenshots`), so follow-ups stay cheap.
3. Main streams the answer with `client.beta.messages.stream`, `output_config.effort` from settings, and `fallbacks: 'default'` so a safety-classifier refusal is retried on another model instead of coming back empty.

The overlay is never in the screenshot: content protection excludes it from `desktopCapturer` just as it does from Zoom.

## Interview flow

1. `startListening()` asks main for microphone permission, boots the worker with the chosen Whisper model, builds an `AudioContext` at 16 kHz, and connects the mic (and optionally a system-audio stream) to the PCM worklet.
2. `onPcm()` runs a tiny voice-activity detector: RMS energy against an adaptive noise floor. Audio is buffered while speech is present and flushed to the worker after ~0.7 s of silence or at 14 s, whichever comes first. Silence-only buffers are discarded, keeping a 0.4 s pre-roll.
3. Worker results become transcript segments. Common Whisper hallucinations on near-silence ("Thank you.") are filtered.
4. With auto-suggest on, 0.9 s after a new segment with at least four fresh words, the rolling transcript (last 3500 chars) goes to Claude with the interview system prompt and `effort: low`. New speech aborts an in-flight suggestion and re-asks.
5. "Answer now" and typed questions in the bar use the same transcript as context.

## Window behaviour

- Frameless, transparent, `vibrancy: 'hud'`, always on top at the `screen-saver` level, visible on all Spaces and over full-screen apps, hidden from Mission Control, Dock hidden, single instance.
- The renderer reports its content height through a `ResizeObserver`; main resizes the native window to match, so the pill is exactly as tall as what is on screen.
- Global shortcuts are registered in main and forwarded as `hotkey` events.
- `HALO_VISIBLE=1` turns content protection off (for taking screenshots of the app). `HALO_SMOKE=1` runs a headless self-check and exits.

## Files

| Path | Purpose |
|---|---|
| `src/main/main.js` | App lifecycle, window, tray, shortcuts, protocol, IPC |
| `src/main/capture.js` | Screen capture and resizing |
| `src/main/claude.js` | Claude streaming and prompts |
| `src/main/config.js` | Settings persistence and key encryption |
| `src/preload.js` | The `window.halo` bridge |
| `src/renderer/index.html` | Markup and CSP |
| `src/renderer/styles.css` | Liquid-glass styling, Geist |
| `src/renderer/app.js` | All UI logic |
| `src/renderer/worker.js` | Local Whisper |
| `src/renderer/pcm-worklet.js` | PCM capture node |
| `src/renderer/logo.js` | The Halo mark as inline SVG |
| `scripts/make-icons.mjs` | Renders the mark to PNG |
| `build.mjs` | esbuild bundle + asset copy |
