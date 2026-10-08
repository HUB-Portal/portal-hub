import { config } from './config';
import { buildApp } from './app';
import { startWorker } from './worker';
import { closePools } from './db';

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });

const worker = config.runWorker ? startWorker({ log: (m) => app.log.error(m) }) : null;
if (worker) app.log.info('worker running inside the API process');
if (!config.mfaRequired) app.log.warn('MFA_REQUIRED is off: a password (or Google) alone signs people in, and nobody is asked for an authenticator code. Set MFA_REQUIRED=true to bring two factor sign in back.');

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
