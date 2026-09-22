// esbuild entry. onnxruntime stays outside this bundle: the .jsh loads the
// ipk-staged ort.*.bundle.min.mjs and passes it to loadKev.
export { loadKev } from '@ai-ecoverse/kev.js';
