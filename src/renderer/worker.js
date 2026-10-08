// Local speech-to-text. Whisper runs entirely on this machine through
// transformers.js (WebGPU when available, WASM otherwise). The model weights are
// downloaded once from Hugging Face and cached by the browser engine.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
try { env.backends.onnx.wasm.wasmPaths = new URL('./ort/', self.location.href).href; } catch { /* keep default */ }

let transcriber = null;
let loadedModel = null;
let device = null;

async function load(model) {
  if (transcriber && loadedModel === model) return;
  transcriber = null;
  const progress_callback = (p) => {
    if (!['initiate', 'download', 'progress', 'done'].includes(p.status)) return;
    self.postMessage({ type: 'progress', status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
  };
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const attempts = hasWebGPU
    ? [{ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: 'q8' }];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback });
      device = opts.device;
      loadedModel = model;
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`whisper load failed on ${opts.device}`, err);
    }
  }
  throw lastErr || new Error('Could not load the speech model.');
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
      self.postMessage({ type: 'ready', device, model: loadedModel });
    } else if (msg.type === 'transcribe') {
      if (!transcriber) throw new Error('Speech model not loaded yet.');
      const opts = { chunk_length_s: 30, return_timestamps: false };
      if (!/\.en$/.test(loadedModel) && msg.language) { opts.language = msg.language; opts.task = 'transcribe'; }
      const out = await transcriber(msg.audio, opts);
      self.postMessage({ type: 'result', id: msg.id, speaker: msg.speaker || null, text: (out?.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
