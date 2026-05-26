import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts'
  },
  format: ['iife'], // IIFE is best for Chrome extensions
  outDir: 'dist',
  clean: true,
  bundle: true,
  minify: false, // Keep readable for MVP
  onSuccess: async () => {
    // Copy manifest to dist after build
    if (!existsSync('dist')) {
      mkdirSync('dist');
    }
    copyFileSync('public/manifest.json', join('dist', 'manifest.json'));
    console.log('Copied manifest.json to dist');
  }
});
