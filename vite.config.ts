import { defineConfig } from 'vite'

export default defineConfig({
  // 5174, not 5173: the three.js version on `main` keeps that port, and the two
  // are meant to run side by side. strictPort so a clash fails loudly instead of
  // sliding to another port and quietly breaking tools/capture.mjs.
  server: { port: 5174, strictPort: true, open: false },
  // No sourcemap: it is 17 MB against a 4 MB bundle, and every build is now a
  // candidate for deployment onto a metered free tier. The dev server serves
  // its own maps, which is where debugging happens anyway.
  build: { target: 'es2022', sourcemap: false },
  // Where Cesium looks for the runtime assets that tools/copy-cesium-assets.mjs
  // stages into public/cesium. Defined at compile time rather than assigned to
  // window in main.ts: ESM hoisting would race Cesium's own initialisation.
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
})
