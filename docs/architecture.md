# Architecture

Halo is a two-process Electron app. The main process owns everything privileged (window flags, screen capture, the API key, Claude calls). The renderer owns the UI and the local speech pipeline. They talk over a small IPC bridge exposed by `src/preload.js`.

```
┌──────────────────────────── main process ─────────────────────────────┐
│ main.js      window, tray, shortcuts, app:// protocol, IPC routing     │
│ capture.js   desktopCapturer → JPEG ≤1568px of the display under cursor│
│ claude.js    @anthropic-ai/sdk streaming, system prompts, error mapping │
│ config.js    halo.json in userData, API key via safeStorage, shortcuts │
│ documents.js resume / job description text extraction (pdf, docx, txt) │
│ backdrop.js  luminance of the screen under the window → dark/light    │
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

1. `runCapture(question)` in `app.js` asks main for a screenshot. `capture.js` uses the saved display-local selection (or finds the display under the cursor when none is saved), captures it at native resolution, crops the saved rectangle or configured logical-pixel margins (top defaults to 120) before encoding, downsizes to a 1568 px long edge (Claude's effective maximum) and returns base64 JPEG.
2. Optional preview shows only the cropped JPEG locally and waits for Send; Cancel uploads nothing. Selection uses a temporary transparent, content-protected window with a restricted preload and saves display-local logical coordinates. Missing displays or changed display sizes stop capture until reselection.
3. The screenshot and the question become one user turn in `convo`. Older turns keep at most two images (`trimOldScreenshots`), so follow-ups stay cheap.
4. Main streams the answer with `client.beta.messages.stream`, `output_config.effort` from settings, and `fallbacks: 'default'` so a safety-classifier refusal is retried on another model instead of coming back empty.

The overlay is never in the screenshot: content protection excludes it from `desktopCapturer` just as it does from Zoom.

## Interview flow

1. `startListening()` asks main for microphone permission, boots the worker with the chosen Whisper model, builds an `AudioContext` at 16 kHz, and connects the mic (and optionally a system-audio stream) to the PCM worklet.
2. `onPcm()` runs a tiny voice-activity detector: RMS energy against an adaptive noise floor. Audio is buffered while speech is present and flushed to the worker after ~0.7 s of silence or at 14 s, whichever comes first. Silence-only buffers are discarded, keeping a 0.4 s pre-roll.
3. Worker results become transcript segments. Common Whisper hallucinations on near-silence ("Thank you.") are filtered.
4. With auto-suggest on, 1.4 s after a new segment, `looksLikeQuestion()` checks the fresh transcript since the last answer: a question mark, or a question opener ("tell me", "how would", "walk me through") in the last two sentences, with at least five new words. Only then does the rolling transcript (last 3500 chars) go to Claude with the interview system prompt and `effort: low`. Continued talking that is not a question leaves the current answer alone. An in-flight answer is never aborted by new speech; the follow-up waits for it to finish, with a 3 s cooldown.
5. A new suggestion is non-destructive: `ask(..., { keep: true })` dims the current answer and swaps it only when the first token of the new one arrives. If the request fails before that, the old answer stays untouched.
6. "Answer now" and typed questions in the bar use the same transcript as context, and every listen request also carries the last two finished suggestions in `<previous_suggestions>` so Claude builds on a follow-up instead of repeating itself. The system prompt is sent with `cache_control`, so the profile is read from cache on every call after the first in a 5-minute window.
7. The system prompt carries the profile from Settings → Profile as `<resume>`, `<job_description>` and `<notes>` blocks inside `<candidate_background>`. Documents are parsed locally in `documents.js` (pdf-parse for PDF, mammoth for DOCX) and capped at 40k characters.

## Audio inputs

`connectInputs()` in `app.js` opens up to two inputs, each into its own AudioWorklet channel with its own voice detection and chunking (`makeChannel` / `attachStream`). The microphone is the `you` channel; the optional second input (a loopback device carrying the call audio) and Windows system audio are `them`. Every transcript segment carries its speaker, so with two inputs the transcript is labelled "You:" / "Interviewer:", `freshText()` feeds only the interviewer's words to the question detector, and Claude is told the lines are labelled.

Cleanup is Chromium's: `noiseSuppression`, `echoCancellation` and `autoGainControl` on every input, toggled by the "Suppress background noise" setting. Chromium's echo canceller references only audio the page itself plays, which is nothing, so it never removes an interviewer heard through speakers. If that is not enough in a noisy room, the next step is an RNNoise AudioWorklet (for example `@jitsi/rnnoise-wasm`) inserted between the source and the PCM worklet; the per-channel design makes that a one-node insertion in `attachStream`.

- macOS shares microphones between apps, so Zoom or Meet holding the mic is not a conflict.
- If a chosen device is missing or busy, Halo retries with the system default and says so in the status line.
- Every track listens for `ended`. On a hot-unplug Halo waits briefly, reopens the inputs, and keeps the transcript.
- `devicechange` refreshes both selectors. Changing a selector while listening reopens the inputs immediately.
- A level meter in the panel footer and the Audio tab shows whether sound is arriving.

## Appearance

In Auto mode `main.js` samples a 192 px wide thumbnail of the display every 2 s while the window is visible. `backdrop.js` averages the luminance under the window and applies hysteresis. Three agreeing samples are needed before flipping, and the luminance must leave a dead zone (0.3 to 0.6). The result sets `nativeTheme.themeSource` (so native menus and scrollbars match) and sends a `theme` event. The renderer sets `data-theme` on `<html>`, and every colour in `styles.css` is a token that flips with it. Main also sends the raw luminance as a `backdrop` event; the renderer maps it onto `--glass-a`, the tint opacity, between 0.80 and 0.95, so the glass gets more solid the closer the backdrop is to its own shade. Without Screen Recording permission, Auto follows the OS appearance.

There is deliberately no macOS vibrancy on the window. The system blur materials are translucent by design and let a white page bleed through dark glass, which is exactly the case that made the overlay hard to read. The glass look comes from the CSS tint, sheen, specular highlights, outline and shadow instead.

A theme flip crossfades the whole overlay for 150 ms instead of swapping tokens in place, because CSS gradients cannot transition. The tint opacity is a registered custom property (`@property --glass-a`) so it eases over 0.9 s.

The thinking state rotates the ring (the `.halo-spin` group, so the ring's static offset is untouched) and shows shimmering placeholder lines in the answer area until text streams in. Both respect reduced motion.

## Presets and placement

`preset` is `talk` or `code`. It changes the minimum window width (660 vs 560; the bar can push wider), the default dock spot (top-center vs top-right), the system prompt suffix (`TALK_PRESET` / `CODE_PRESET` in `claude.js`; Code enforces Approach, Code, Complexity, Edge cases, How to explain it), and whether auto-suggest runs (never in Code). `homePosition()` in `main.js` returns the user's last dragged position for the preset if that display is still attached, otherwise the preset's dock spot. The `moved` event stores positions per preset; the dock hotkey cycles `DOCK_SPOTS` and clears the stored drag. Bottom-docked windows grow upward when the panel opens so the bar stays put.

## Focus hygiene

The only thing a browser-based proctoring tool or a video call can observe about Halo is whether the foreground app lost focus. With `keepFocus` on (default) the window is created `focusable: false` and shown with `showInactive()`, so hotkeys and button clicks never take focus. Typing needs focus: `mousedown` on a text field asks main to make the window focusable and focus it; Enter or Esc asks main to release it, which on macOS deactivates the app (handing focus back to the previous app) and re-shows the window inactive. Halo never synthesises keyboard or mouse input.

## Window behaviour

- Frameless, transparent, always on top at the `screen-saver` level, visible on all Spaces and over full-screen apps, hidden from Mission Control, Dock hidden, single instance.
- The window is sized from the content. The renderer reports the height of `#app` and the width the bar needs (`neededWidth()`: every visible control at its natural size, plus a minimum usable input of 200 px in Talk or 150 px in Code). Main applies `max(preset floor, needed)`, capped to the display, and anchors the resize to whichever edge the user is on: right-docked bars grow leftwards, centred bars stay centred, bottom-docked bars grow upwards. A `MutationObserver` on the bar and `document.fonts.ready` re-measure when controls appear, hide, or the font lands.
- Global shortcuts are stored in settings (`shortcuts.toggle/capture/listen/collapse/dock`), registered in main with `globalShortcut`, and forwarded to the renderer as `hotkey` events. Changing one re-registers all four and reports failures back so the Shortcuts tab can flag a combination another app owns.
- The panel has two independent states: `panelOpen` (there is content) and `collapsed` (the user folded it to the bar with `⌘⇧M`). User-initiated actions un-collapse; automatic interview suggestions respect the collapse and mark the chevron with a dot instead.
- `HALO_VISIBLE=1` turns content protection off (for taking screenshots of the app). `HALO_SMOKE=1` runs a headless self-check and exits.

## Files

| Path | Purpose |
|---|---|
| `src/main/main.js` | App lifecycle, window, tray, shortcuts, protocol, IPC |
| `src/main/capture.js` | Screen capture and resizing |
| `src/main/claude.js` | Claude streaming and prompts |
| `src/main/config.js` | Settings persistence, key encryption, default shortcuts |
| `src/main/documents.js` | Resume / job description text extraction |
| `src/main/backdrop.js` | Backdrop luminance and theme hysteresis |
| `src/preload.js` | The `window.halo` bridge |
| `src/renderer/index.html` | Markup and CSP |
| `src/renderer/styles.css` | Liquid-glass styling, Geist |
| `src/renderer/app.js` | All UI logic |
| `src/renderer/worker.js` | Local Whisper |
| `src/renderer/pcm-worklet.js` | PCM capture node |
| `src/renderer/logo.js` | The Halo mark as inline SVG |
| `scripts/make-icons.mjs` | Renders the mark to PNG |
| `build.mjs` | esbuild bundle + asset copy |
