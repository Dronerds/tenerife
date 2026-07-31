import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  // Terrain shaders live as .glsl so the same source can be read by the
  // GLSL/TS noise-parity test without being duplicated in a template literal.
  assetsInclude: ['**/*.glsl'],
})
