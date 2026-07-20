import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    pageProbe: 'src/content/pageProbe.ts',
    popup: 'src/popup/index.ts'
  },
  format: ['iife'],
  outDir: 'dist',
  clean: true,
  bundle: true,
  minify: false,
  onSuccess: async () => {
    if (!existsSync('dist')) mkdirSync('dist');
    // 复制 manifest 和 popup html
    copyFileSync('public/manifest.json', join('dist', 'manifest.json'));
    copyFileSync('src/popup/index.html', join('dist', 'popup.html'));
    console.log('Copied manifest.json and popup.html to dist');
  }
});
