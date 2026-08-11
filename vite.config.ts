import { defineConfig } from 'vite'

export default defineConfig({
  // 5174, not 5173: the three.js version on `main` keeps that port, and the two
  // are meant to run side by side. strictPort so a clash fails loudly instead of
  // sliding to another port and quietly breaking tools/capture.mjs.
  server: { port: 5174, strictPort: true, open: false },
  build: { target: 'es2022', sourcemap: true },
  // Where Cesium looks for the runtime assets that tools/copy-cesium-assets.mjs
  // stages into public/cesium. Defined at compile time rather than assigned to
  // window in main.ts: ESM hoisting would race Cesium's own initialisation.
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
})
