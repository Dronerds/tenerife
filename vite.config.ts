import { defineConfig } from 'vite'

export default defineConfig({
  // 5174, not 5173: the three.js version on `main` keeps that port, and the two
  // are meant to run side by side. strictPort so a clash fails loudly instead of
  // sliding to another port and quietly breaking tools/capture.mjs.
  server: { port: 5174, strictPort: true, open: false },
  build: { target: 'es2022', sourcemap: true },
})
