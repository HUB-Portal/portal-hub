import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { NOTICES } from '../src/services/notify';
import { UrlProblem, checkUrlShape, isBlockedAddress, isLocalHost, resetNetOptions, setNetOptions, validateTargetUrl } from '../src/services/netSafety';
import { MAX_ATTEMPTS, RETRY_MINUTES, bodyOf, signPayload, signatureHeader, DISABLE_AFTER_FAILURES } from '../src/services/webhookDelivery';
import { WEBHOOK_EVENTS, casePayload, publicCaseEvent } from '../src/services/webhooks';
import { exportCell } from '../src/services/exports';
import { cleanCidrs } from '../src/services/apiKeysAdmin';
import { ipAllowed } from '../src/auth/apikeys';
import { daysBetween } from '../src/services/v1';

afterEach(() => resetNetOptions());

describe('address safety', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '192.0.0.8', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '192.88.99.1',
    '::', '::1', 'fe80::1', 'fe80::abcd:1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1', '2001:db8::1', '2001::1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '100::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101', '::127.0.0.1', '::10.0.0.1', '2002:7f00:1::1', '2002:c0a8:101::1',
    '[::1]', 'localhost', 'not an address', '',
  ];
  const allowed = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '11.0.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808'];

  it.each(blocked)('refuses %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(allowed)('accepts the public address %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('web address rules', () => {
  const problem = (raw: string): string | null => {
    try {
      checkUrlShape(raw);
      return null;
    } catch (e) {
      if (e instanceof UrlProblem) return e.code;
      throw e;
    }
  };

  it('accepts https addresses with a public host name', () => {
    setNetOptions({ allowLocal: false });
    expect(problem('https://erp.partner-example.com/hooks/kline')).toBeNull();
    expect(problem('https://erp.partner-example.com:8443/a/b?x=1')).toBeNull();
    expect(problem('https://93.184.216.34/hook')).toBeNull();
  });

  it('refuses everything dangerous when local targets are not allowed (production)', () => {
    setNetOptions({ allowLocal: false });
    expect(problem('http://erp.partner-example.com/hook')).toBe('not_https');
    expect(problem('ftp://erp.partner-example.com/hook')).toBe('not_https');
    expect(problem('https://user:secret@erp.partner-example.com/hook')).toBe('has_credentials');
    expect(problem('https://user@erp.partner-example.com/hook')).toBe('has_credentials');
    expect(problem('https://erp.partner-example.com/hook#frag')).toBe('invalid_url');
    expect(problem('not a url')).toBe('invalid_url');
    expect(problem('https://localhost/hook')).toBe('blocked_host');
    expect(problem('https://printer.local/hook')).toBe('blocked_host');
    expect(problem('https://db.internal/hook')).toBe('blocked_host');
    expect(problem('https://intranet/hook')).toBe('blocked_host');
    expect(problem('https://127.0.0.1/hook')).toBe('blocked_address');
    expect(problem('https://10.0.0.5/hook')).toBe('blocked_address');
    expect(problem('https://169.254.169.254/latest/meta-data')).toBe('blocked_address');
    expect(problem('https://[::1]/hook')).toBe('blocked_address');
    expect(problem('https://[fd00::1]/hook')).toBe('blocked_address');
    expect(problem('https://[::ffff:10.0.0.1]/hook')).toBe('blocked_address');
    // numeric tricks are normalised by the URL parser before the check
    expect(problem('https://2130706433/hook')).toBe('blocked_address');
    expect(problem('https://0x7f.1/hook')).toBe('blocked_address');
    expect(problem('https://017700000001/hook')).toBe('blocked_address');
    expect(problem('http://127.0.0.1:4000/hook')).toBe('not_https');
    expect(problem('http://' + 'a'.repeat(600) + '.example.com/')).toBe('invalid_url');
  });

  it('allows http to localhost only with the development allowance', () => {
    setNetOptions({ allowLocal: true });
    expect(problem('http://127.0.0.1:5555/hook')).toBeNull();
    expect(problem('http://localhost:5555/hook')).toBeNull();
    expect(problem('http://[::1]:5555/hook')).toBeNull();
    // still nothing else on the private network
    expect(problem('http://10.0.0.5/hook')).toBe('not_https');
    expect(problem('https://10.0.0.5/hook')).toBe('blocked_address');
    expect(problem('https://printer.local/hook')).toBe('blocked_host');
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('10.0.0.1')).toBe(false);
  });

  it('resolves the host at save time and refuses private answers, also mixed ones', async () => {
    const answers: Record<string, string[]> = {
      'good.example.com': ['93.184.216.34'],
      'rebind.example.com': ['127.0.0.1'],
      'mixed.example.com': ['93.184.216.34', '10.1.1.1'],
      'meta.example.com': ['169.254.169.254'],
      'v6.example.com': ['fd00::5'],
    };
    setNetOptions({
      allowLocal: false,
      resolver: async (h) => {
        const a = answers[h];
        if (!a) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
        return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
    });
    await expect(validateTargetUrl('https://good.example.com/hook')).resolves.toBeInstanceOf(URL);
    for (const h of ['rebind', 'mixed', 'meta', 'v6']) await expect(validateTargetUrl(`https://${h}.example.com/hook`)).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(validateTargetUrl('https://nowhere.example.com/hook')).rejects.toMatchObject({ code: 'unresolvable' });
  });
});

describe('signature', () => {
  it('is hex HMAC-SHA256 of "<t>.<body>" with the whole secret as key', () => {
    const secret = 'whsec_' + 'A'.repeat(43);
    const body = '{"id":"x","type":"case.shipped"}';
    const t = 1_790_000_000;
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(signPayload(secret, t, body)).toBe(expected);
    expect(signatureHeader(secret, t, body)).toBe(`t=${t},v1=${expected}`);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // a different secret, time or body gives a different signature
    expect(signPayload(secret + 'x', t, body)).not.toBe(expected);
    expect(signPayload(secret, t + 1, body)).not.toBe(expected);
    expect(signPayload(secret, t, body + ' ')).not.toBe(expected);
  });

  it('sends the body in natural key order', () => {
    expect(bodyOf({ id: 'i', type: 't', created_at: 'c', org_code: 'ACME', data: { a: 1 } })).toBe('{"id":"i","type":"t","created_at":"c","org_code":"ACME","data":{"a":1}}');
  });
});

describe('retry plan', () => {
  it('follows the contract', () => {
    expect([...RETRY_MINUTES]).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(MAX_ATTEMPTS).toBe(8);
    expect(DISABLE_AFTER_FAILURES).toBe(25);
  });
});

describe('events and payloads', () => {
  it('lists the subscribable events', () => {
    expect([...WEBHOOK_EVENTS]).toEqual(['case.submitted', 'case.on_hold', 'case.received', 'case.stage_changed', 'case.shipped', 'case.delivered', 'case.cancelled', 'claim.updated', 'materials.low_stock', 'spec.updated']);
  });

  it('maps internal hooks to public events', () => {
    expect(publicCaseEvent('case.stage_changed', 'received')).toBe('case.received');
    expect(publicCaseEvent('case.stage_changed', 'printing')).toBe('case.stage_changed');
    expect(publicCaseEvent('case.stage_changed', null)).toBe('case.stage_changed');
    for (const e of ['case.submitted', 'case.on_hold', 'case.shipped', 'case.delivered', 'case.cancelled']) expect(publicCaseEvent(e, null)).toBe(e);
    for (const e of ['case.ready', 'case.rerouted', 'case.released', 'case.something']) expect(publicCaseEvent(e, null)).toBeNull();
  });

  it('builds case payloads from references only', () => {
    const row = {
      ref: 'ACME-000001', partner_case_id: 'AC-1', status: 'shipped', stage: 'shipped', site_code: 'PT-CHV', carrier: 'DHL', tracking: 'T1', aligners_shipped: 12,
      // fields that must never travel
      patient_enc: 'secret', notes_enc: 'secret', hold_reason: 'Zelda Quimby', patient_first_enc: 'x',
    };
    const p = casePayload(row);
    expect(p).toEqual({ ref: 'ACME-000001', case_id: 'AC-1', status: 'shipped', simple_status: 'shipped', stage: 'shipped', stage_label: 'Shipped', site: 'PT-CHV', carrier: 'DHL', tracking_number: 'T1', aligners_shipped: 12 });
    expect(JSON.stringify(p)).not.toMatch(/secret|Zelda/);
    const early = casePayload({ ...row, status: 'in_production', stage: 'printing' });
    expect(early).not.toHaveProperty('carrier');
    expect(early).not.toHaveProperty('tracking_number');
    expect(early).toMatchObject({ simple_status: 'production', stage_label: '3D printing' });
  });
});

describe('CSV cells', () => {
  it('defuses formulas, tabs and carriage returns, and keeps plain numbers', () => {
    expect(exportCell('=1+1')).toBe("'=1+1");
    expect(exportCell('+49 170 1')).toBe("'+49 170 1");
    expect(exportCell('-cmd|x')).toBe("'-cmd|x");
    expect(exportCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(exportCell('\t=1')).toBe("'\t=1");
    expect(exportCell('-19.622')).toBe('-19.622');
    expect(exportCell(12)).toBe('12');
    expect(exportCell(null)).toBe('');
    expect(exportCell('a,b')).toBe('"a,b"');
    expect(exportCell('say "hi"')).toBe('"say ""hi"""');
    expect(exportCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(exportCell('\r=1')).toBe(`"'\r=1"`);
  });
});

describe('key settings', () => {
  it('cleans and validates IP ranges', () => {
    expect(cleanCidrs(['203.0.113.0/24', ' 198.51.100.7 ', '203.0.113.0/24', '2001:db8::/32'])).toEqual(['203.0.113.0/24', '198.51.100.7', '2001:db8::/32']);
    expect(() => cleanCidrs(['not an ip'])).toThrow();
    expect(() => cleanCidrs(['10.0.0.0/33'])).toThrow();
    expect(() => cleanCidrs([''])).toThrow();
    expect(() => cleanCidrs(Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`))).toThrow();
  });
  it('matches addresses against ranges, including mapped IPv6', () => {
    expect(ipAllowed([], '8.8.8.8')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '203.0.113.77')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.77')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '203.0.114.1')).toBe(false);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::5')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:db9::5')).toBe(false);
    expect(ipAllowed(['198.51.100.7'], '198.51.100.7')).toBe(true);
    expect(ipAllowed(['198.51.100.7'], '198.51.100.8')).toBe(false);
  });
  it('counts days between dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
    expect(daysBetween('2026-01-01', '2027-01-02')).toBe(366);
    expect(daysBetween('2026-03-01', '2026-02-01')).toBe(-28);
  });
});

describe('email notices', () => {
  const samples: Record<string, Record<string, unknown>> = {
    case_stage: { caseId: 'c1', ref: 'ACME-000001', stage: 'received' },
    case_shipped: { caseId: 'c1', ref: 'ACME-000001' },
    case_delivered: { caseId: 'c1', ref: 'ACME-000001' },
    case_on_hold: { caseId: 'c1', ref: 'ACME-000001' },
    case_cancelled: { caseId: 'c1', ref: 'ACME-000001' },
    claim_opened: { claimId: 'k1', number: 'CLM-2026-00001', ref: 'ACME-000001' },
    claim_status: { claimId: 'k1', number: 'CLM-2026-00001', ref: 'ACME-000001' },
    claim_message: { claimId: 'k1', number: 'CLM-2026-00001', ref: 'ACME-000001' },
    claim_decision: { claimId: 'k1', number: 'CLM-2026-00001', ref: 'ACME-000001' },
    claim_closed: { claimId: 'k1', number: 'CLM-2026-00001', ref: 'ACME-000001' },
    spec_proposed: { specId: 's1', orgId: 'o1' },
    spec_signed: { specId: 's1', orgId: 'o1' },
    material_low_stock: { materialId: 'm1', siteCode: 'PT-CHV', name: 'Typed name', onHand: 3 },
    webhook_disabled: { webhookId: 'w1' },
  };

  it('has fixed wording for every kind, without dash separators or typed text', () => {
    expect(Object.keys(NOTICES).sort()).toEqual(Object.keys(samples).sort());
    for (const [kind, spec] of Object.entries(NOTICES)) {
      const d = { ...samples[kind], title: 'Typed title', body: 'Typed body', note: 'Typed note' };
      const texts = [spec.subject(d), spec.line(d), spec.path('partner', d), spec.path('kline', d), spec.key(d)];
      for (const t of texts) {
        expect(t, kind).not.toMatch(/ [-–—] /);
        expect(t, kind).not.toMatch(/Typed/);
      }
      expect(spec.subject(d).length).toBeGreaterThan(5);
      expect(spec.path('partner', d).startsWith('/portal/')).toBe(true);
      expect(spec.path('kline', d).startsWith('/console/') || kind === 'material_low_stock' || kind === 'webhook_disabled').toBe(true);
    }
  });

  it('sends a case in production mail only for the first step into production', () => {
    expect(NOTICES.case_stage.when!({ stage: 'received' })).toBe(true);
    expect(NOTICES.case_stage.when!({ source: 'portal' })).toBe(true);
    expect(NOTICES.case_stage.when!({ stage: 'printing' })).toBe(false);
    expect(NOTICES.case_stage.when!({ stage: 'packing' })).toBe(false);
  });
});

describe('request logs', () => {
  it('keep references but hide case IDs, searches and tokens', async () => {
    const { redactUrl } = await import('../src/http/util');
    expect(redactUrl('/api/v1/cases/ACME-000001')).toBe('/api/v1/cases/ACME-000001');
    expect(redactUrl('/api/v1/cases/ACME-000001/files?x=1')).toBe('/api/v1/cases/ACME-000001/files?x=1');
    expect(redactUrl('/api/v1/cases/55813')).toBe('/api/v1/cases/[redacted]');
    expect(redactUrl('/api/v1/cases/55813%20Marc%20Alonso/submit')).toBe('/api/v1/cases/[redacted]/submit');
    expect(redactUrl('/api/v1/cases?case_id=55813&page=2')).toBe('/api/v1/cases?case_id=[redacted]&page=2');
    expect(redactUrl('/api/cases?search=Marc%20Alonso&page=1')).toBe('/api/cases?search=[redacted]&page=1');
    expect(redactUrl('/api/v1/files/0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11')).toBe('/api/v1/files/0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11');
    expect(redactUrl('/api/v1/shipments?from=2026-03-01&to=2026-03-31')).toBe('/api/v1/shipments?from=2026-03-01&to=2026-03-31');
  });
});
