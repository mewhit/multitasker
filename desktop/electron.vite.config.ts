import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: '../dist/desktop/src',
      rollupOptions: {
        external: ['electron', 'ws', 'node-window-manager'],
        input: path.resolve(__dirname, 'src/main/main.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'main.js',
        },
      },
    },
  },
  preload: {
    build: {
      outDir: '../dist/desktop/src',
      rollupOptions: {
        external: ['electron'],
        input: path.resolve(__dirname, 'src/preload/preload.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'preload.js',
        },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: '../dist/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
    },
  },
});
