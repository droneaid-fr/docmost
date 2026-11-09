import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@docmost/editor-ext': path.resolve(
        __dirname,
        '../../packages/editor-ext/src/index.ts',
      ),
      // DroneAid: Enterprise code is never built; @/ee resolves to our stubs
      '@/ee': path.resolve(__dirname, './src/droneaid/ee-stubs'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    exclude: [...configDefaults.exclude, 'src/ee/**'],
  },
});
