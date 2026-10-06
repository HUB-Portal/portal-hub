import { createHash } from 'node:crypto';
import { config } from '../config';
import { base32Encode, totpCode, base32Decode, STEP_SECONDS } from '../crypto/totp';

export const DEMO_PASSWORD = 'Demo2026PartnerHub';

export function isDemoEmail(email: string): boolean {
  return /@([a-z0-9-]+\.)*demo$/i.test(email);
}

/** Stable authenticator secret for a demo account (same after every seed, so an enrolled phone keeps working). */
export function demoTotpSecret(email: string): string {
  return base32Encode(createHash('sha256').update(`kph-demo-totp|${email.toLowerCase()}`).digest().subarray(0, 20));
}

export function demoCurrentCode(email: string): { code: string; secondsLeft: number } | null {
  if (!config.demoMode || !isDemoEmail(email)) return null;
  const now = Date.now() / 1000;
  return { code: totpCode(base32Decode(demoTotpSecret(email)), now), secondsLeft: STEP_SECONDS - Math.floor(now % STEP_SECONDS) };
}
