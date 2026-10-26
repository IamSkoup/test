// node generate-vapid.mjs           → prints a NEW VAPID key pair
// node generate-vapid.mjs --apply   → ALSO writes the public key into wrangler.toml and ../config.js
//                                      and saves the private key to vapid-private.txt (only the key, nothing else)
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const j = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
if (!process.argv.includes('--apply')) {
  console.log('PUBLIC  (wrangler.toml VAPID_PUBLIC_KEY and config.js webPushVapidPublicKey):\n' + pub + '\n');
  console.log('PRIVATE (only for `wrangler secret put VAPID_PRIVATE_KEY` — paste ONLY these characters):\n' + j.d + '\n');
} else {
  const edit = (file, re, repl) => {
    if (!existsSync(file)) { console.log('  ! not found:', file); return; }
    const t = readFileSync(file, 'utf8');
    if (!re.test(t)) { console.log('  ! pattern not found in', file); return; }
    writeFileSync(file, t.replace(re, repl)); console.log('  ✓ updated', file);
  };
  edit('wrangler.toml', /^(VAPID_PUBLIC_KEY\s*=\s*)"[^"]*"/m, `$1"${pub}"`);
  edit('../config.js', /(webPushVapidPublicKey\s*:\s*)"[^"]*"/, `$1"${pub}"`);
  writeFileSync('vapid-private.txt', j.d);
  console.log('  ✓ private key saved to vapid-private.txt (delete this file after the next step)\n');
  console.log('Next:\n  cmd:         wrangler secret put VAPID_PRIVATE_KEY < vapid-private.txt');
  console.log('  PowerShell:  Get-Content vapid-private.txt -Raw | wrangler secret put VAPID_PRIVATE_KEY');
  console.log('  then:        wrangler deploy   (and upload the updated ../config.js to GitHub Pages)');
}
