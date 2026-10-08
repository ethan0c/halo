// Bundles the renderer (UI + local Whisper worker) into dist/ with esbuild.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
mkdirSync(join(dist, 'ort'), { recursive: true });

await build({
  entryPoints: ['src/renderer/app.js', 'src/renderer/worker.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome134'],
  outdir: dist,
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

for (const f of ['index.html', 'pcm-worklet.js']) copyFileSync(join('src/renderer', f), join(dist, f));

// Ship every ONNX Runtime wasm variant next to the app so transcription never
// touches a CDN. Which variant gets loaded (asyncify, jspi, jsep, plain) depends
// on the transformers.js build and the backend it picks at runtime.
const ortDist = 'node_modules/onnxruntime-web/dist';
const ortFiles = readdirSync(ortDist).filter((f) => f.startsWith('ort-wasm-simd-threaded'));
for (const f of ortFiles) copyFileSync(join(ortDist, f), join(dist, 'ort', f));
console.log(`copied ${ortFiles.length} ONNX Runtime wasm files`);
console.log('build complete -> dist/');
