import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../src/MacacoLive.App/wwwroot',
    emptyOutDir: true,
    target: 'esnext',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
