// Canonical JSON and the SHA-256 check for production specifications come from shared/spec.ts,
// so the browser computes exactly what the server signed.
import { canonicalJson, hashSpec } from '@shared/spec';

export { canonicalJson };
export const hashContent = hashSpec;
