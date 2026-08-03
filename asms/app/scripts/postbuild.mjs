// Ensures wrangler skips uploading the Astro Worker bundle as static assets.
// The Astro Cloudflare adapter emits ./dist/_worker.js/ and ./dist/_routes.json
// inside the same directory wrangler treats as assets, so we mark them ignored.
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
if (!existsSync(dist)) {
  console.error(`postbuild: ${dist} not found — astro build likely failed`);
  process.exit(1);
}

const target = resolve(dist, '.assetsignore');
writeFileSync(target, '_worker.js\n_routes.json\n', 'utf8');
console.log(`postbuild: wrote ${target}`);
