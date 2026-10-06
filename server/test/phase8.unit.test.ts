import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import {
  CASE_ADDRESS_KEYS, CASE_ADDRESS_LIMITS, CASE_ADDRESS_REQUIRED_MESSAGE, caseAddressView, isCompleteCaseAddress, validateCaseAddress, validateCaseAddressField, validateCaseAddressPatch,
  type CaseAddress,
} from '../../shared/caseAddress';
import {
  LOGO_INSTRUCTIONS, LOGO_MAX_BYTES, checkLogoBytes, checkLogoDimensions, checkLogoFile, jpegSize, pngSize, readLogoSize, svgSize,
} from '../../shared/logo';
import { FakePortalClient, PortalError, toPortalShipping } from '../src/services/portal';
import { PortalV2Client } from '../src/services/portal/v2';
import { jpegOfSize, pngOfSize } from './helpers';

const GOOD: CaseAddress = {
  company: 'Acme Aligners Ltd', fullName: 'Alex Acme', street: '1 Rua Direita', city: 'Chaves', postalCode: '5400-001', stateProvince: 'Vila Real', country: 'PT', phone: '+351276000000', email: 'goods@acme.demo',
};

// ---------------------------------------------------------------------------
describe('case address validator', () => {
  it('accepts a complete address and cleans the values', () => {
    expect(validateCaseAddress(GOOD)).toEqual({ ok: true, value: GOOD });
    const r = validateCaseAddress({ ...GOOD, street: '  1   Rua   Direita ', country: 'pt', email: 'Goods@Acme.Demo', stateProvince: 'N/A' });
    expect(r).toMatchObject({ ok: true, value: { street: '1 Rua Direita', country: 'PT', email: 'goods@acme.demo', stateProvince: 'N/A' } });
    expect(isCompleteCaseAddress(GOOD)).toBe(true);
  });

  it('requires all nine fields and names each missing one', () => {
    const r = validateCaseAddress({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.path)).toEqual([...CASE_ADDRESS_KEYS]);
    for (const k of CASE_ADDRESS_KEYS) {
      const one = validateCaseAddress({ ...GOOD, [k]: '   ' });
      expect(one.ok, k).toBe(false);
      if (!one.ok) expect(one.problems.map((p) => p.path)).toEqual([k]);
    }
    expect(isCompleteCaseAddress(null)).toBe(false);
    expect(isCompleteCaseAddress('x')).toBe(false);
    expect(isCompleteCaseAddress([])).toBe(false);
  });

  it('applies the portal limits exactly', () => {
    const limits = { company: 150, fullName: 255, street: 255, city: 255, postalCode: 10, stateProvince: 64, country: 2, phone: 15, email: 255 };
    expect(CASE_ADDRESS_LIMITS).toEqual(limits);
    const long = (n: number) => 'a'.repeat(n);
    for (const k of ['company', 'fullName', 'street', 'city', 'stateProvince'] as const) {
      expect(validateCaseAddressField(k, long(limits[k])).ok, `${k} at limit`).toBe(true);
      const over = validateCaseAddressField(k, long(limits[k] + 1));
      expect(over.ok, `${k} over limit`).toBe(false);
      if (!over.ok) expect(over.message).toContain(`at most ${limits[k]} characters`);
    }
    expect(validateCaseAddressField('postalCode', '1234567890').ok).toBe(true);
    expect(validateCaseAddressField('postalCode', '12345678901').ok).toBe(false);
    expect(validateCaseAddressField('phone', '123456789012345').ok).toBe(true);
    const longPhone = validateCaseAddressField('phone', '1234567890123456');
    expect(longPhone.ok).toBe(false);
    if (!longPhone.ok) expect(longPhone.message).toMatch(/at most 15 characters/);
    expect(validateCaseAddressField('email', `${long(64)}@${long(60)}.example.com`).ok).toBe(true);
  });

  it('checks the country against the ISO list', () => {
    for (const ok of ['PT', 'de', ' us ', 'XK']) expect(validateCaseAddressField('country', ok).ok, ok).toBe(true);
    for (const bad of ['ZZ', 'P', 'PRT', '', 'Portugal', 12, null]) expect(validateCaseAddressField('country', bad).ok, String(bad)).toBe(false);
    expect(validateCaseAddressField('country', 'de')).toEqual({ ok: true, value: 'DE' });
  });

  it('checks the phone number as typed', () => {
    for (const ok of ['+351276000000', '+34 910 000 000', '(030) 12345', '0049-30-123', '12345']) expect(validateCaseAddressField('phone', ok).ok, ok).toBe(true);
    for (const bad of ['abc12345', '+351.276.000', '1234', 'tel: 12345', '12345<', '+--  ']) expect(validateCaseAddressField('phone', bad).ok, bad).toBe(false);
    // as typed: no spaces are removed, so a number with spaces that is longer than 15 characters is refused
    expect(validateCaseAddressField('phone', '+351 276 000 000').ok).toBe(false);
    expect(validateCaseAddressField('phone', '+351276000000')).toEqual({ ok: true, value: '+351276000000' });
  });

  it('checks the postal code, state and text fields', () => {
    for (const ok of ['5400-001', 'SW1A 1AA', '10001', 'D-12345']) expect(validateCaseAddressField('postalCode', ok).ok, ok).toBe(true);
    for (const bad of ['-', '<1>', '12/34']) expect(validateCaseAddressField('postalCode', bad).ok, bad).toBe(false);
    expect(validateCaseAddressField('stateProvince', 'N/A')).toEqual({ ok: true, value: 'N/A' });
    expect(validateCaseAddressField('street', 'Main <b>Street</b>').ok).toBe(false);
    expect(validateCaseAddressField('city', 'Bad\u0001City').ok).toBe(false);
    expect(validateCaseAddressField('email', 'nope').ok).toBe(false);
    expect(validateCaseAddressField('email', '').ok).toBe(false);
    expect(validateCaseAddressField('email', '')).toEqual({ ok: false, message: 'Enter the email address.' });
  });

  it('validates a partial update field by field and ignores unknown keys', () => {
    expect(validateCaseAddressPatch({ city: ' Porto ', extra: 'x' })).toEqual({ ok: true, value: { city: 'Porto' } });
    expect(validateCaseAddressPatch({})).toEqual({ ok: true, value: {} });
    const bad = validateCaseAddressPatch({ city: 'Porto', phone: 'abc', postalCode: '' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map((p) => p.path)).toEqual(['postalCode', 'phone']);
  });

  it('shows a stored value as a full object, or nothing', () => {
    expect(caseAddressView(undefined)).toBeNull();
    expect(caseAddressView({})).toBeNull();
    expect(caseAddressView({ city: '  ' })).toBeNull();
    expect(caseAddressView({ city: 'Porto' })).toEqual({ company: '', fullName: '', street: '', city: 'Porto', postalCode: '', stateProvince: '', country: '', phone: '', email: '' });
    expect(caseAddressView(GOOD)).toEqual(GOOD);
    expect(isCompleteCaseAddress({ ...GOOD, phone: '' })).toBe(false);
    expect(CASE_ADDRESS_REQUIRED_MESSAGE).toBe('Add your case address in the company profile, then press Try again.');
  });

  it('maps the Hub fields to the nine portal names without changing a value', () => {
    expect(toPortalShipping(GOOD)).toEqual({
      shipping_street_address: '1 Rua Direita', shipping_city: 'Chaves', shipping_country: 'PT', shipping_postal_code: '5400-001', shipping_state_province: 'Vila Real',
      shipping_full_name: 'Alex Acme', shipping_phone_number: '+351276000000', shipping_email_address: 'goods@acme.demo', shipping_company: 'Acme Aligners Ltd',
    });
  });
});

// ---------------------------------------------------------------------------
describe('logo size rules', () => {
  const svg = (attrs: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10"/></svg>`;

  it('reads PNG dimensions from the header', () => {
    expect(pngSize(pngOfSize(800, 240))).toEqual({ format: 'png', width: 800, height: 240 });
    expect(pngSize(pngOfSize(4000, 1))).toEqual({ format: 'png', width: 4000, height: 1 });
    expect(pngSize(Buffer.from('not a png'))).toBeNull();
    expect(pngSize(pngOfSize(0, 10))).toBeNull();
    const noIhdr = Buffer.from(pngOfSize(800, 240));
    noIhdr.write('IDAT', 12, 'latin1');
    expect(pngSize(noIhdr)).toBeNull();
    expect(pngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('reads JPEG dimensions, skipping other segments, and finds progressive frames', () => {
    expect(jpegSize(jpegOfSize(600, 200))).toEqual({ format: 'jpeg', width: 600, height: 200 });
    const progressive = Buffer.from(jpegOfSize(1200, 300));
    const at = progressive.indexOf(Buffer.from([0xff, 0xc0, 0x00, 0x11]));
    progressive[at + 1] = 0xc2;
    expect(jpegSize(progressive)).toEqual({ format: 'jpeg', width: 1200, height: 300 });
    // an EXIF segment with a long payload in front is skipped by its length
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x32]), Buffer.alloc(0x30, 9)]);
    const base = jpegOfSize(900, 300);
    const withExif = Buffer.concat([base.subarray(0, 2), exif, base.subarray(2)]);
    expect(jpegSize(withExif)).toEqual({ format: 'jpeg', width: 900, height: 300 });
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(jpegSize(Buffer.from('plain text'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]))).toBeNull();
  });

  it('reads the ratio of an SVG from the viewBox, else width and height', () => {
    expect(svgSize(svg('viewBox="0 0 300 90"'))).toEqual({ format: 'svg', width: 300, height: 90 });
    expect(svgSize(svg('viewBox="0,0,300,90" width="10" height="10"'))).toEqual({ format: 'svg', width: 300, height: 90 });
    expect(svgSize(svg('width="240" height="80"'))).toEqual({ format: 'svg', width: 240, height: 80 });
    expect(svgSize(svg('width="240px" height="80px"'))).toEqual({ format: 'svg', width: 240, height: 80 });
    expect(svgSize(svg("viewBox='0 0 120 40'"))).toEqual({ format: 'svg', width: 120, height: 40 });
    expect(svgSize(svg('width="100%" height="100%"'))).toBeNull();
    expect(svgSize(svg('viewBox="0 0 0 90"'))).toBeNull();
    expect(svgSize(svg(''))).toBeNull();
    expect(svgSize('<html></html>')).toBeNull();
    // stroke-width on the root is not the width
    expect(svgSize(svg('stroke-width="5" viewBox="0 0 300 100"'))).toEqual({ format: 'svg', width: 300, height: 100 });
  });

  it('accepts and refuses at the documented boundaries', () => {
    expect(checkLogoDimensions('png', 800, 240)).toBeNull();
    expect(checkLogoDimensions('png', 400, 120)).toBeNull();
    expect(checkLogoDimensions('jpeg', 400, 400)).toBeNull();
    expect(checkLogoDimensions('png', 4000, 4000)).toBeNull();
    expect(checkLogoDimensions('png', 720, 120)).toBeNull(); // exactly 6 to 1
    expect(checkLogoDimensions('png', 399, 120)?.code).toBe('logo_too_small');
    expect(checkLogoDimensions('png', 400, 119)?.code).toBe('logo_too_small');
    expect(checkLogoDimensions('png', 4001, 1000)?.code).toBe('logo_too_large');
    expect(checkLogoDimensions('png', 1000, 4001)?.code).toBe('logo_too_large');
    expect(checkLogoDimensions('png', 721, 120)?.code).toBe('logo_bad_ratio');
    expect(checkLogoDimensions('png', 400, 500)?.code).toBe('logo_bad_ratio');
    expect(checkLogoDimensions('png', 0, 0)?.code).toBe('logo_type');
    expect(checkLogoDimensions('svg', 300, 90)).toBeNull();
    expect(checkLogoDimensions('svg', 10, 10)).toBeNull(); // vector: only the ratio counts
    expect(checkLogoDimensions('svg', 100, 10)?.code).toBe('logo_bad_ratio');
    expect(checkLogoDimensions('svg', 10, 100)?.code).toBe('logo_bad_ratio');
    expect(checkLogoDimensions('svg', 0, 0)?.code).toBe('logo_bad_ratio');
    expect(checkLogoBytes(LOGO_MAX_BYTES)).toBeNull();
    expect(checkLogoBytes(LOGO_MAX_BYTES + 1)?.code).toBe('logo_too_large');
  });

  it('repeats the instruction in every refusal and checks whole files', () => {
    for (const p of [checkLogoDimensions('png', 100, 100), checkLogoDimensions('png', 5000, 5000), checkLogoDimensions('png', 1000, 100), checkLogoBytes(LOGO_MAX_BYTES + 1), checkLogoDimensions('svg', 0, 0)]) {
      expect(p, 'a problem').toBeTruthy();
      expect(p!.message).toContain(LOGO_INSTRUCTIONS);
      expect(p!.message).not.toMatch(/ [-–—] /);
    }
    expect(LOGO_INSTRUCTIONS).toMatch(/800 x 240/);
    expect(checkLogoFile('png', pngOfSize(800, 240))).toBeNull();
    expect(checkLogoFile('jpeg', jpegOfSize(300, 100))?.code).toBe('logo_too_small');
    expect(checkLogoFile('svg', Buffer.from(svg('viewBox="0 0 300 90"')))).toBeNull();
    expect(checkLogoFile('svg', Buffer.from(svg('')))?.code).toBe('logo_bad_ratio');
    expect(checkLogoFile('png', Buffer.from('garbage'))?.code).toBe('logo_type');
    expect(checkLogoFile('png', Buffer.alloc(LOGO_MAX_BYTES + 1))?.code).toBe('logo_too_large');
    expect(readLogoSize('svg', Buffer.from(svg('viewBox="0 0 300 90"')))).toEqual({ format: 'svg', width: 300, height: 90 });
  });
});

// ---------------------------------------------------------------------------
describe('portal shipping address', () => {
  describe('v2 over http', () => {
    let srv: http.Server;
    let base: string;
    const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    let respond: () => { status: number; body: any } = () => ({ status: 200, body: { data: {} } });
    const UUID = 'aaaaaaaa-1111-2222-3333-444444444444';

    beforeAll(async () => {
      srv = http.createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', (d) => parts.push(d));
        req.on('end', () => {
          seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
          const r = respond();
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.body));
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => srv.close(() => r())));
    const mk = () => new PortalV2Client({ baseUrl: base, apiKey: 'test-key-not-real-0123456789', userUuid: '123e4567-e89b-12d3-a456-426614174000', doctorId: 'doc-1', rules: { allowLocal: true } });

    it('sends PATCH cases/{uuid}/shipping-address with the nine portal fields and the usual headers', async () => {
      const c = mk();
      await c.setShippingAddress(UUID, GOOD);
      await c.close();
      expect(seen).toHaveLength(1);
      const s = seen[0]!;
      expect(`${s.method} ${s.url}`).toBe(`PATCH /api/v2/cases/${UUID}/shipping-address`);
      expect(s.headers['content-type']).toBe('application/json');
      expect(s.headers['x-kline-api-key']).toBe('test-key-not-real-0123456789');
      expect(s.headers['x-kline-api-user-uuid']).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(s.headers['x-kline-doctor-id']).toBe('doc-1');
      expect(JSON.parse(s.body)).toEqual(toPortalShipping(GOOD));
      expect(Object.keys(JSON.parse(s.body)).sort()).toEqual([
        'shipping_city', 'shipping_company', 'shipping_country', 'shipping_email_address', 'shipping_full_name', 'shipping_phone_number', 'shipping_postal_code', 'shipping_state_province', 'shipping_street_address',
      ]);
      seen.length = 0;
    });

    it('maps portal errors like every other call and never copies the portal message', async () => {
      const c = mk();
      const cases: [number, string, boolean][] = [[400, 'validation', false], [401, 'auth', false], [404, 'not_found', false], [409, 'validation', false], [429, 'rate_limited', true], [503, 'server', true]];
      for (const [status, code, retryable] of cases) {
        respond = () => ({ status, body: { message: 'Shipping address of Marc Alonso is locked' } });
        const err = await c.setShippingAddress(UUID, GOOD).catch((e) => e);
        expect(err, String(status)).toBeInstanceOf(PortalError);
        expect(err.code).toBe(code);
        expect(err.retryable).toBe(retryable);
        expect(err.message).not.toContain('Marc');
      }
      await expect(c.setShippingAddress('not a uuid!', GOOD)).rejects.toMatchObject({ code: 'validation' });
      await c.close();
      respond = () => ({ status: 200, body: { data: {} } });
    });
  });

  describe('fake client', () => {
    it('stores the mapped address, records the call and refuses once the case is submitted', async () => {
      const f = new FakePortalClient();
      const { uuid } = await f.createCase({ firstName: 'a', lastName: 'b', gender: 2, productType: 0 });
      await f.setShippingAddress(uuid, GOOD);
      expect(f.cases.get(uuid)!.shippingAddress).toEqual(toPortalShipping(GOOD));
      expect(f.calls.map((c) => c.op)).toEqual(['createCase', 'setShippingAddress']);
      await f.submitCase(uuid);
      await expect(f.setShippingAddress(uuid, GOOD)).rejects.toMatchObject({ code: 'validation', status: 409 });
      await expect(f.setShippingAddress(uuid, { ...GOOD, phone: '' })).rejects.toMatchObject({ status: 400 });
      f.failNext('setShippingAddress', 'server');
      const other = await f.createCase({ firstName: 'a', lastName: 'b', gender: 2, productType: 0 });
      await expect(f.setShippingAddress(other.uuid, GOOD)).rejects.toMatchObject({ code: 'server' });
      await f.setShippingAddress(other.uuid, GOOD);
    });
  });
});
