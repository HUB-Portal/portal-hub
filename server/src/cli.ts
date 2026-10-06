import { randomBytes } from 'node:crypto';
import { CLI_USAGE } from './cliUsage';

// Two commands work before the server has any settings (a fresh server has no keys yet): help and gen-key.
// Everything else loads the settings, so the real implementation is imported only after this check.
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(CLI_USAGE);
  process.exit(0);
}

if (cmd === 'gen-key') {
  const i = rest.indexOf('--id');
  const id = (i >= 0 ? rest[i + 1] : undefined) ?? 'k' + Date.now().toString(36);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    console.error('The key id may only hold letters, digits, "_" and "-" (up to 32 characters).');
    process.exit(1);
  }
  const key = randomBytes(32).toString('base64');
  console.log(`Add this entry to MASTER_KEYS (merge it into the JSON object) and set ACTIVE_KEY_ID=${id} when ready to rotate:`);
  console.log(JSON.stringify({ [id]: key }));
  console.log('Store an offline copy of the key before you use it. A lost key cannot be recovered.');
  process.exit(0);
}

await import('./cliMain');
