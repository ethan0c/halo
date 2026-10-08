# Troubleshooting

## Permissions (macOS)

Halo needs two permissions. In development they are granted to **Electron**, not Halo, and macOS only applies a new grant after the app relaunches.

| Symptom | Fix |
|---|---|
| Capture says "Screen Recording permission is required" | System Settings → Privacy & Security → Screen & System Audio Recording → enable Electron (or Halo). Quit and run `npm start` again. |
| Listen says microphone access was denied | System Settings → Privacy & Security → Microphone → enable Electron (or Halo). Relaunch. |
| The permission toggle is on but it still fails | Remove the entry with the minus button, relaunch, and accept the prompt again. This happens when the Electron binary was updated. |

`npm run dist` produces `release/mac-arm64/Halo.app` (or `mac/`). Launch that instead of `npm start` and the permissions attach to Halo itself.

## Overlay

- **It does not appear.** Press `⌘⇧H`. The app lives in the menu bar (the ring icon); clicking it toggles the window.
- **Shortcuts do nothing.** Another app owns the combination. Settings → Shortcuts flags the ones that failed to register; pick a different combination there. Halo runs as a single instance, so a second launch just focuses the first.
- **The panel vanished but the bar is still there.** It is collapsed (`⌘⇧M` or the chevron). Press it again to expand. A dot on the chevron means a new suggestion arrived while collapsed.
- **I can see it in my screen share.** You started with `npm run dev`, which deliberately turns protection off. Use `npm start`. Also note content protection hides the window from software capture only; a phone pointed at the monitor still sees it.
- **It is not on top of a full-screen app.** Move the cursor to that display and press `⌘⇧Space` twice. The window is set to show over full-screen Spaces, but macOS occasionally needs the re-show after a Space switch.
- **Glass looks flat.** The blur comes from macOS vibrancy. Reduce Transparency in Accessibility settings disables it system-wide.

## Claude

| Message | Meaning |
|---|---|
| "Your Anthropic API key was rejected" | Wrong or revoked key. Paste a new one in Settings → Account. |
| "This API key does not have access to that model" | Your organisation does not have the selected model. Pick another in Settings. |
| "Rate limited by Anthropic" | Wait a few seconds. Interview auto-suggest can fire often; turn it off and use "Answer now". |
| "Claude declined this request" | A safety classifier refused and no fallback model accepted it. Rephrase or capture again. |
| "Could not reach the Anthropic API" | Network. Halo only needs `api.anthropic.com` (and `huggingface.co` once, for the speech model). |

Answers are capped at 4096 output tokens on purpose; the overlay is for quick help, not essays.

## Interview mode

- **Speech model never finishes downloading.** It is fetched from Hugging Face on first use (tiny ≈ 80 MB, base ≈ 150 MB, small ≈ 500 MB). Check the connection, then press Listen again; downloads resume from cache.
- **Transcript is empty while people are talking.** Open Settings and pick the right input. If the interviewer is on headphones, the mic cannot hear them: either use speakers or install a loopback driver such as BlackHole, create a Multi-Output Device in Audio MIDI Setup that includes BlackHole and your headphones, and select BlackHole as Halo's input. Direct system-audio capture is only supported by Electron on Windows.
- **Transcript is garbled.** Switch to Whisper small, or raise the model from tiny. Background noise raises the adaptive noise floor; a quieter room helps.
- **Suggestions come too often or too late.** Auto-suggest waits for ~0.9 s of silence after a new segment with at least four new words. Turn it off and use "Answer now" if you prefer to control timing.
- **It transcribes "Thank you." out of nothing.** A known Whisper quirk on silence; the common ones are filtered. Lower your mic gain if it persists.

## Profile documents

- **"No text found in that file."** The PDF is a scan with no text layer. Export it from your editor as PDF again, or save it as DOCX/TXT.
- **"Unsupported file type."** PDF, DOCX, TXT, Markdown and HTML are supported. Pages (.pages) files must be exported first.
- Very long documents are cut at 40,000 characters; trim the resume to what matters for the role.

## Build

- `npm run smoke` loads the UI headlessly and prints a JSON probe (`fontLoaded`, `hasLogo`, `webgpu`, …). Exit code 0 means the renderer is healthy.
- Running `electron .` from inside an editor terminal can inherit `ELECTRON_RUN_AS_NODE=1` and crash with `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`. Run from a normal terminal, or prefix with `env -u ELECTRON_RUN_AS_NODE`.
- Logo or tray icon changes: edit `src/renderer/logo.js` and the matching geometry in `scripts/make-icons.mjs`, then `npm run icons`.
