import express from 'express';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { AccessContext, GatewayRequest } from '../src/access/request-context';
import { LimitsService } from '../src/metering/limits.service';
import { ConsumeResult } from '../src/metering/rate-limiter.service';
import { billableUnits, ProxyHandler } from '../src/proxy/proxy.controller';
import { NAMING } from './fixtures/acme';

/**
 * The proxy's half of 'upstream' metering, against a real upstream: the quota-exhausted signal goes out, the
 * billable units come back, are charged, never reach the client, and the X-RateLimit-* headers follow the charge.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const caller = { type: 'CLIENT', key: 'acme-m2m-erp', label: 'erp', issuedAt: 0, tenants: [], global: [] } as unknown as AccessContext['caller'];

interface Seen { quotaExhausted?: string; spoofedUnits?: string }

function start(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

describe('proxy: upstream metering', () => {
  let upstream: { url: string; close: () => Promise<void> };
  let gateway: { url: string; close: () => Promise<void> };
  const seen: Seen[] = [];
  const charged: number[] = [];
  let access: AccessContext;

  beforeAll(async () => {
    const up = express();
    // /units/<n>: answers n billable units; /limited: the upstream's own 429 (it would have had to pay).
    up.get('/orders/:id/quote', (req, res) => {
      seen.push({ quotaExhausted: req.header(NAMING.quotaExhaustedHeader), spoofedUnits: req.header(NAMING.billableUnitsHeader) });
      if (req.params.id === 'limited') return void res.status(429).json({ message: 'needs a fresh call' });
      res.setHeader(NAMING.billableUnitsHeader, req.params.id);
      res.json({ ok: true });
    });
    upstream = await start(up);

    const limits = {
      charge: async (_tid: string, _c: unknown, units: number): Promise<ConsumeResult> => {
        charged.push(units);
        return { allowed: true, limit: 10, remaining: 10 - 4 - units, resetsAt: new Date(Date.now() + 3_600_000) };
      },
    } as unknown as LimitsService;
    const config = { get: () => upstream.url } as never;
    const handler = new ProxyHandler(config, NAMING, { principal: false, permissions: false }, limits);
    const gw = express();
    gw.use((req, res) => {
      (req as GatewayRequest).access = access;
      handler.handle(req as GatewayRequest, res);
    });
    gateway = await start(gw);
  });

  afterAll(async () => {
    await gateway.close();
    await upstream.close();
  });

  beforeEach(() => {
    seen.length = 0;
    charged.length = 0;
    access = {
      authType: 'CLIENT', caller, tenant: { id: TENANT, orgId: 'o', alias: 'acme' }, member: true, permissions: [], endpoint: '/orders/:id/quote',
      metering: { mode: 'upstream', exhausted: false, state: { allowed: true, limit: 10, remaining: 6 } },
    };
  });

  it('charges the units the upstream reports, strips the header and reports the limit after the charge', async () => {
    const r = await get(`${gateway.url}/orders/1/quote`);
    expect(r.status).toBe(200);
    expect(charged).toEqual([1]);
    expect(r.headers[NAMING.billableUnitsHeader]).toBeUndefined();
    expect(r.headers['x-ratelimit-remaining']).toBe('5');
    expect(r.headers['retry-after']).toBeUndefined();
  });

  it('charges nothing for a free answer (0 units) and reports the limit as the guard found it', async () => {
    const r = await get(`${gateway.url}/orders/0/quote`);
    expect(charged).toEqual([]);
    expect(r.headers['x-ratelimit-remaining']).toBe('6');
  });

  it('tells the upstream when the limit is spent, and adds Retry-After to its 429', async () => {
    access.metering = { mode: 'upstream', exhausted: true, state: { allowed: false, limit: 10, remaining: 0, resetsAt: new Date(Date.now() + 60_000) } };
    const r = await get(`${gateway.url}/orders/limited/quote`);
    expect(seen[0].quotaExhausted).toBe('1');
    expect(r.status).toBe(429);
    expect(charged).toEqual([]);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never forwards a client-sent quota-exhausted or billable-units header', async () => {
    await get(`${gateway.url}/orders/0/quote`, { [NAMING.quotaExhaustedHeader]: '1', [NAMING.billableUnitsHeader]: '99' });
    expect(seen[0]).toEqual({ quotaExhausted: undefined, spoofedUnits: undefined });
  });

  it("does not charge or rewrite headers on routes that are not 'upstream'", async () => {
    access.metering = { mode: 'none' };
    const r = await get(`${gateway.url}/orders/3/quote`);
    expect(charged).toEqual([]);
    expect(r.headers[NAMING.billableUnitsHeader]).toBeUndefined();
    expect(r.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('reads the units header defensively', () => {
    expect([undefined, '', 'abc', '-2', '0'].map((v) => billableUnits(v))).toEqual([0, 0, 0, 0, 0]);
    expect(billableUnits('2.7')).toBe(2);
    expect(billableUnits(['3', '9'])).toBe(3);
    expect(billableUnits('100000')).toBe(1000);
  });
});
