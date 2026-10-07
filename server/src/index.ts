import { config } from './config';
import { buildApp } from './app';
import { startWorker } from './worker';
import { closePools } from './db';

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });

if (!config.mfaRequired) app.log.warn('MFA_REQUIRED=false: two factor sign in is OFF. Anyone with a password (or Google) gets a full session. Turn it back on before real use.');

const worker = config.runWorker ? startWorker({ log: (m) => app.log.error(m) }) : null;
if (worker) app.log.info('worker running inside the API process');

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await worker?.stop();
  await app.close();
  await closePools();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
