// Bundles the renderer (UI + local Whisper worker) into dist/ with esbuild.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
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

// Ship ONNX Runtime's wasm next to the app so transcription never touches a CDN.
const ortDist = 'node_modules/onnxruntime-web/dist';
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  if (existsSync(join(ortDist, f))) copyFileSync(join(ortDist, f), join(dist, 'ort', f));
}
console.log('build complete -> dist/');
