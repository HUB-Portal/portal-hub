import { config } from '../../config';
import { decryptField, fieldAad } from '../../crypto/keys';
import { PortalError, type PortalClient } from './client';
import { FakePortalClient } from './fake';
import { PortalV2Client } from './v2';

export * from './client';
export { FakePortalClient } from './fake';

export interface PortalSettings {
  baseUrl?: string;
  apiKeyEnc?: string;
  userUuid?: string;
  doctorId?: string | null;
  defaultGender?: number;
}

export type PortalFactory = (org: { id: string; settings: Record<string, any> }) => PortalClient | null;

let override: PortalFactory | undefined;
/** Tests inject a fake here. Return null to fall through to the normal choice. */
export function setPortalClientFactory(f: PortalFactory | undefined): void {
  override = f;
}

/** Shared fake used in development and tests (PORTAL_FAKE=true) when an organisation has no credentials. */
export const devFakePortal = new FakePortalClient();

/** True when the client is the shared in memory fake: nothing was or will be sent to a real portal. */
export function isDemoPortal(client: PortalClient): boolean {
  return client === devFakePortal;
}

export function portalSettings(settings: Record<string, any> | null | undefined): PortalSettings {
  return (settings?.portal_api ?? {}) as PortalSettings;
}

export function portalConfigured(settings: Record<string, any> | null | undefined): boolean {
  const p = portalSettings(settings);
  return !!(p.baseUrl && p.apiKeyEnc && p.userUuid);
}

/**
 * The client for an organisation: injected fake (tests), real v2 client from its credentials, or the shared fake when PORTAL_FAKE is on.
 * Without credentials and without PORTAL_FAKE it throws not_configured: nothing is ever pretended to be sent.
 */
export function getPortalClient(org: { id: string; settings: Record<string, any> }): PortalClient {
  const injected = override?.(org);
  if (injected) return injected;
  const p = portalSettings(org.settings);
  if (p.baseUrl && p.apiKeyEnc && p.userUuid) {
    let apiKey: string;
    try {
      apiKey = decryptField(p.apiKeyEnc, fieldAad.portalKey(org.id));
    } catch {
      throw new PortalError('not_configured');
    }
    return new PortalV2Client({ baseUrl: p.baseUrl, apiKey, userUuid: p.userUuid, doctorId: p.doctorId ?? null });
  }
  if (config.portalFake && !config.isProd) return devFakePortal;
  throw new PortalError('not_configured');
}
