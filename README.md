# Halo

A quiet AI copilot that floats over your screen and is invisible to screen recording and screen sharing. Local-first, one dependency on the outside world: your Anthropic API key.

<p align="center"><img src="assets/icon.png" width="96" alt="Halo logo"></p>

## What it does

- **Capture** (`⌘⇧↩`) — screenshots the display under your cursor and asks Claude what you most likely need (solve the problem on screen, answer the question, explain the error, draft the reply). Type a question in the bar to steer it; follow-ups keep the conversation.
- **Listen** (`⌘⇧L`) — interview mode. Transcribes the conversation with a Whisper model that runs entirely on your machine, then suggests what to say next as the interviewer talks. "Answer now" forces a suggestion; auto-suggest can be turned off.
- **Invisible to capture** — the window is flagged `NSWindowSharingNone` (Electron `setContentProtection`), so Zoom, Meet, Teams, QuickTime and screen recordings all see straight through it. It also excludes itself from its own screenshots.
- **Floats everywhere** — always on top, on every Space, over full-screen apps, hidden from Mission Control, no Dock icon. Lives in the menu bar.

## Run it

```bash
npm install
npm start
```

First launch:

1. Paste your Anthropic API key (console.anthropic.com → API keys). It is encrypted with the macOS keychain and stored in `~/Library/Application Support/Halo/halo.json`. `ANTHROPIC_API_KEY` in your environment also works.
2. macOS will ask for **Screen Recording** the first time you press Capture, and **Microphone** the first time you press Listen. Grant both, then relaunch if prompted. In dev the permission is granted to "Electron"; run `npm run dist` to get a real `Halo.app` under `release/` that owns its own permissions.
3. The first Listen downloads the speech model once (about 150 MB for Whisper base) and caches it locally.

## Shortcuts

| Keys | Action |
|---|---|
| `⌘⇧Space` | Show / hide the overlay |
| `⌘⇧↩` | Capture screen and ask |
| `⌘⇧L` | Start / stop interview listening |
| `Esc` | Hide |

Drag the bar to move it. The "screen" toggle next to the input attaches a fresh screenshot to every question.

## Settings

- **Model**: Claude Opus 5.5 by default; Sonnet 5.5 and Haiku 4.5 are faster, Fable 5.1 is the most capable. Interview suggestions always run at low effort for speed.
- **About you**: paste your resume summary and the role. It is sent as context so suggested answers draw on your real experience.
- **Microphone / input**: to hear the interviewer, use speakers, or install a loopback device such as [BlackHole](https://existential.audio/blackhole/) and select it (or a multi-output device mixing it with your mic). Direct system-audio capture is only available on Windows.
- **Speech model**: Whisper tiny / base / small. Runs on WebGPU when available, WASM otherwise.

## How it is built

- Electron main process (`src/main/`): window flags, global shortcuts, tray, screen capture, settings, and all Claude calls (`@anthropic-ai/sdk`, streaming, server-side refusal fallbacks enabled). The API key never enters the renderer.
- Renderer (`src/renderer/`): the glass UI in plain HTML/CSS/JS with the Geist variable font, bundled by esbuild into `dist/`. Served from a privileged `app://` scheme so the Whisper weights can be cached and WebGPU/threads work.
- `src/renderer/worker.js`: transformers.js Whisper pipeline in a Web Worker. Audio is gated by a simple energy-based voice-activity detector and sent in utterance-sized chunks.
- `scripts/make-icons.mjs`: renders the logo to PNG for the menu bar and app icon, no image library needed.

Useful scripts: `npm run dev` (overlay visible to screen capture, for screenshots), `npm run smoke` (headless load check), `npm run dist` (build `Halo.app`).

## Notes

- Content protection is honoured by every capture API on macOS and Windows. Hardware capture cards and phone cameras still see your monitor.
- Use responsibly and within the rules of whatever you are in.
