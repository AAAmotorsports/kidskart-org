#!/usr/bin/env node
// Rotation helper for ADMIN_PASSWORD_HASH (asms/app/src/lib/adminAuth.ts).
//
// Usage:
//   node scripts/gen-admin-hash.mjs                  → prompts for password
//   echo "<password>" | node scripts/gen-admin-hash.mjs --stdin
//
// Output format: scrypt:<salt_hex>:<hash_hex>
// Paste into Cloudflare Dashboard → kidskart-asms Worker → Settings →
//   Variables and Secrets → Add secret → Name=ADMIN_PASSWORD_HASH, Type=Secret.
// After saving, click "Re-deploy latest version" so the Secret binds.
//
// NEVER commit the output anywhere in git. The scrypt format is slower to
// crack than SHA-256 but the plaintext password must still be kept private.
//
// Also useful: generate a fresh ADMIN_COOKIE_SECRET
//   node scripts/gen-admin-hash.mjs --cookie-secret

import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';

const scryptAsync = promisify(scrypt);

async function hashPasswordScrypt(password) {
  const salt = randomBytes(16);
  const buf = /** @type {Buffer} */ (await scryptAsync(password, salt, 32));
  return `scrypt:${salt.toString('hex')}:${buf.toString('hex')}`;
}

async function readPassword() {
  if (argv.includes('--stdin')) {
    // Read entire stdin as the password (useful for `echo "x" | ...`).
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const pw = await rl.question(
    'New admin password (will NOT echo on most terminals, press Enter when done):\n> '
  );
  rl.close();
  return pw.trim();
}

async function main() {
  if (argv.includes('--cookie-secret')) {
    // 32 bytes random hex for ADMIN_COOKIE_SECRET.
    console.log('\nSuggested ADMIN_COOKIE_SECRET (set as Cloudflare Secret):');
    console.log(randomBytes(32).toString('hex'));
    return;
  }
  const pw = await readPassword();
  if (!pw || pw.length < 12) {
    console.error('\nERROR: password must be at least 12 characters.');
    exit(1);
  }
  const stored = await hashPasswordScrypt(pw);
  console.log('\nADMIN_PASSWORD_HASH (set as Cloudflare Secret, NOT in wrangler.jsonc):');
  console.log(stored);
  console.log('\nTo verify locally:');
  console.log(`  node -e "import('./src/lib/adminAuth.ts').then(m => m.passwordOk(${JSON.stringify(pw)}, '${stored}')).then(console.log)"`);
}

main().catch((e) => {
  console.error('fatal:', e);
  exit(2);
});
