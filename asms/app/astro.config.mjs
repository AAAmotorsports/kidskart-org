import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
    platformProxy: { enabled: true },
  }),
  site: 'https://asms.pages.dev',
  trailingSlash: 'ignore',
  compressHTML: true,
  vite: {
    ssr: {
      external: ['node:async_hooks', 'node:buffer', 'node:crypto', 'node:events', 'node:util'],
    },
  },
});
