import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// build 後に dist/.assetsignore を書く (_worker.js を静的アセットとして上げないため)
const writeAssetsIgnore = {
  name: 'photo-write-assetsignore',
  hooks: {
    'astro:build:done': ({ dir }) => {
      writeFileSync(fileURLToPath(new URL('.assetsignore', dir)), '_worker.js\n_routes.json\n', 'utf8');
    },
  },
};

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'compile', platformProxy: { enabled: true } }),
  integrations: [writeAssetsIgnore],
  trailingSlash: 'ignore',
  compressHTML: true,
  vite: {
    ssr: { external: ['node:async_hooks', 'node:buffer', 'node:crypto', 'node:events', 'node:util'] },
  },
});
