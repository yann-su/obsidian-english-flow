import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  platform: 'browser', format: 'cjs', target: 'es2022', outfile: 'dist/main.js',
  sourcemap: false, banner: { js: '/* English Reading Flow — MIT License */' }
});
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
