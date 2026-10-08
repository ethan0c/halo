// All Claude calls happen here in the main process so the API key never
// reaches the renderer. Responses stream back over IPC as text deltas.
const Anthropic = require('@anthropic-ai/sdk');

const BASE_SYSTEM = `You are Halo, a discreet real-time copilot floating over the user's screen. The user is busy (often on a call or in a timed session), so be fast and direct.
Rules:
- Lead with the answer. No preamble, no restating the question, no sign-off.
- Prefer short paragraphs and tight bullet lists. Use Markdown. Put code in fenced blocks with a language tag.
- If something is a multiple-choice or short-answer question, state the answer first, then one line of why.
- If asked to solve a coding problem, give the approach in one or two sentences, then complete working code, then complexity.
- If the request is ambiguous, make the most likely assumption and say it in a few words instead of asking.`;

const CAPTURE_SYSTEM = `${BASE_SYSTEM}

The transcript may carry speaker labels ("Interviewer:" and "You:"). When it does, answer the interviewer's latest turn and treat "You:" lines as what the candidate already said.

The user has shared a screenshot of their screen. Work out what they most likely need help with (a question, a problem, an error, a form, a message to reply to, a document to understand) and handle it. If several things are on screen, address the most prominent or most recent one and mention the others in one line.`;

const INTERVIEW_SYSTEM = `${BASE_SYSTEM}

You are whispering to a candidate during a live interview. You receive a rolling transcript of the conversation captured from a microphone, so it may contain transcription errors and a mix of interviewer and candidate speech. Infer the interviewer's latest question or prompt and give the candidate exactly what to say next:
- Speak in first person, in natural spoken language the candidate can read aloud.
- 2 to 6 sentences for behavioral or conceptual questions, or 3 to 5 crisp bullets if a list is clearer.
- For technical or coding questions: one-sentence approach, then the key steps or code, then edge cases.
- If the latest speech is not a question (small talk, the candidate mid-answer), give 1 to 3 short talking points to continue with.
- Use the candidate's background below when it is relevant; never invent experience they do not have.`;

const CODE_PRESET = `

Setting: a live coding interview. The candidate is typing in a shared editor while talking. Use exactly this shape, with these bold labels and nothing before the first one:
**Approach** — one or two lines.
**Code** — the complete solution in the language visible on screen (or the transcript's), in one fenced block.
**Complexity** — time and space, one line.
**Edge cases** — two to four bullets worth saying out loud.
**How to explain it** — two or three short bullets the candidate can use to walk through the solution in their own words: the key insight, why the obvious alternative is worse, and what to say while typing it.`;

const TALK_PRESET = `

Setting: a conversational interview (video call or in person). Everything you give will be spoken, so write for the ear: no headings, no code unless asked, concrete examples over abstractions.`;

function buildSystem(mode, profile = {}) {
  const base = (mode === 'listen' ? INTERVIEW_SYSTEM : CAPTURE_SYSTEM) + (profile.preset === 'code' ? CODE_PRESET : TALK_PRESET);
  const parts = [];
  if (profile.resume?.text) parts.push(`<resume source="${profile.resume.name || 'resume'}">\n${profile.resume.text.trim()}\n</resume>`);
  if ((profile.job || '').trim()) parts.push(`<job_description>\n${profile.job.trim()}\n</job_description>`);
  if ((profile.context || '').trim()) parts.push(`<notes>\n${profile.context.trim()}\n</notes>`);
  return parts.length ? `${base}\n\n<candidate_background>\n${parts.join('\n\n')}\n</candidate_background>` : base;
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to that model.';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found. Pick another model in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic. Try again in a moment.';
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status}): ${err.message}`;
  if (err?.name === 'AbortError') return 'Cancelled.';
  return err?.message || String(err);
}

/**
 * Streams one answer. `onDelta(text)` fires for each text chunk.
 * Returns { text, stopReason, stopDetails, usage }.
 */
async function streamAnswer({ apiKey, model, effort, mode, profile, messages, signal, onDelta }) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  const isHaiku = /haiku/i.test(model);
  const params = {
    model,
    max_tokens: 4096, // overlay answers are deliberately short
    system: buildSystem(mode, profile),
    messages,
  };
  if (!isHaiku) {
    params.output_config = { effort: mode === 'listen' ? 'low' : effort || 'medium' };
  }
  if (/claude-(opus|sonnet)-5-5|fable/i.test(model)) {
    // Server-side fallbacks: if a safety classifier declines, Anthropic
    // re-routes to a suitable model instead of returning an empty refusal.
    params.fallbacks = 'default';
    params.betas = ['server-side-fallback-2026-07-01'];
  }

  const stream = client.beta.messages.stream(params, { signal });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onDelta(event.delta.text);
  }
  const final = await stream.finalMessage();
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, stopReason: final.stop_reason, stopDetails: final.stop_details ?? null, usage: final.usage, model: final.model };
}

module.exports = { streamAnswer, describeError };
