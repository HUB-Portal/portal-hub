import type { Readable } from 'node:stream';
import type { CaseAddress } from '../../../../shared/caseAddress';

/** Fields the portal accepts uploads for (API 2.6). Only other documents are used by the Hub today. */
export type PortalField =
  | 'field_case_upper_scan'
  | 'field_case_lower_scan'
  | 'field_case_bite_scan'
  | 'field_case_radiographs'
  | 'field_case_other_docs'
  | `field_case_clinical_photo_0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export interface PortalCaseInput {
  firstName: string;
  lastName: string;
  /** Portal gender code. 2 is "prefer not to say". */
  gender: number;
  /** 0 is Clear Aligners. */
  productType: number;
  doctorInstructions?: string | null;
}

/** What the Hub reads from the portal for one case. Never holds patient data. */
export interface PortalCaseInfo {
  uuid: string;
  /** Portal status code: New, InPlanning, PendingPlanReview, PlanRejected, InProduction, Shipped. */
  status: string | null;
  /** For shipped cases: the tracking number, or a space delimited "courier tracking" string. */
  trackingNumber: string | null;
  /** ISO 8601 datetime, null until the portal sets it. */
  expectedShippingDate: string | null;
}

/** The nine fields of PATCH /api/v2/cases/{uuid}/shipping-address. All are required by the portal. */
export interface PortalShippingBody {
  shipping_street_address: string;
  shipping_city: string;
  shipping_country: string;
  shipping_postal_code: string;
  shipping_state_province: string;
  shipping_full_name: string;
  shipping_phone_number: string;
  shipping_email_address: string;
  shipping_company: string;
}

/** Maps the Hub's case address to the portal field names. Values are sent exactly as stored. */
export function toPortalShipping(a: CaseAddress): PortalShippingBody {
  return {
    shipping_street_address: a.street,
    shipping_city: a.city,
    shipping_country: a.country,
    shipping_postal_code: a.postalCode,
    shipping_state_province: a.stateProvince,
    shipping_full_name: a.fullName,
    shipping_phone_number: a.phone,
    shipping_email_address: a.email,
    shipping_company: a.company,
  };
}

export type PortalErrorCode = 'not_configured' | 'network' | 'timeout' | 'auth' | 'validation' | 'not_found' | 'rate_limited' | 'server' | 'unexpected' | 'blocked_url';

/**
 * Errors from the portal. The message is fixed text per code: the portal's own message is never copied
 * because it may repeat patient data.
 */
export class PortalError extends Error {
  constructor(
    public code: PortalErrorCode,
    public status?: number,
  ) {
    super(PORTAL_MESSAGES[code] + (status ? ` (HTTP ${status})` : ''));
    this.name = 'PortalError';
  }
  /** True when trying again later may work. */
  get retryable(): boolean {
    return ['network', 'timeout', 'rate_limited', 'server'].includes(this.code);
  }
}

const PORTAL_MESSAGES: Record<PortalErrorCode, string> = {
  not_configured: 'The K Line portal is not set up for this company. Add the address, key and user ID in the portal settings.',
  network: 'The K Line portal could not be reached.',
  timeout: 'The K Line portal took too long to answer.',
  auth: 'The K Line portal did not accept the API key.',
  validation: 'The K Line portal rejected the request.',
  not_found: 'The K Line portal could not find that item.',
  rate_limited: 'The K Line portal asked us to slow down.',
  server: 'The K Line portal had a problem on its side.',
  unexpected: 'The K Line portal sent an unexpected answer.',
  blocked_url: 'The portal address is not allowed.',
};

/** Thin adapter over one version of the K Line customer portal API. */
export interface PortalClient {
  ping(): Promise<void>;
  createCase(input: PortalCaseInput): Promise<{ uuid: string }>;
  uploadFile(caseUuid: string, field: PortalField, name: string, stream: Readable, size: number): Promise<{ fileUuid: string | null }>;
  /** Sets the case's shipping address (the Hub's Case address). The portal refuses it once a direct manufacturing case is submitted, so call it before submitCase. */
  setShippingAddress(caseUuid: string, address: CaseAddress): Promise<void>;
  submitCase(caseUuid: string): Promise<void>;
  getCase(caseUuid: string): Promise<PortalCaseInfo>;
}
