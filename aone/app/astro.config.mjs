import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Astro integration: writes ./dist/.assetsignore after build so wrangler
// does not try to upload _worker.js/ and _routes.json as static assets.
const writeAssetsIgnore = {
  name: 'aone-write-assetsignore',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const target = fileURLToPath(new URL('.assetsignore', dir));
      writeFileSync(target, '_worker.js\n_routes.json\n', 'utf8');
      console.log(`[aone] wrote ${target}`);
    },
  },
};

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: { enabled: true },
  }),
  integrations: [writeAssetsIgnore],
  trailingSlash: 'ignore',
  compressHTML: true,
  vite: {
    ssr: {
      external: ['node:async_hooks', 'node:buffer', 'node:crypto', 'node:events', 'node:util'],
    },
  },
});
