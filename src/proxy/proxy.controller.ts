import { All, Controller, Logger, Req, Res, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { ProxyRoute } from '../access/decorators';
import { GatewayRequest } from '../access/request-context';
import { AppConfig } from '../config/configuration';
import { GatewayNaming } from '../options';

/** Never forwarded upstream in either direction, whatever the product. */
const STRIP_ALWAYS = [
  'authorization', 'x-api-key', 'cookie', 'x-tenant-id', 'host', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization',
];
const STRIP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie']);

/**
 * Streams authorized calls to the upstream unchanged. Body parsing is off for these paths (see bootstrapGateway),
 * so request bodies are piped through as-is. Documented in Swagger from the upstream's own schema.
 *
 * Never forwarded upstream: credentials, hop-by-hop headers, and any client-sent tenant or principal header —
 * the upstream trusts those, so only the gateway may set them (from the authenticated caller).
 */
export class ProxyHandler {
  private readonly log = new Logger('ProxyController');
  private readonly upstream: URL;
  private readonly agent: http.Agent;
  private readonly strip: Set<string>;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly naming: GatewayNaming,
    private readonly forwardPrincipal: boolean,
  ) {
    this.upstream = new URL(config.get('upstreamUrl', { infer: true }));
    const Agent = this.upstream.protocol === 'https:' ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 256 });
    this.strip = new Set([...STRIP_ALWAYS, naming.tenantHeader, naming.principalHeader]);
  }

  forward(req: GatewayRequest, res: Response) {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!this.strip.has(k) && v !== undefined) headers[k] = v;
    headers['x-forwarded-for'] = [req.header('x-forwarded-for'), req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-proto'] = req.protocol;
    if (req.access?.tenant) headers[this.naming.tenantHeader] = req.access.tenant.id;
    if (this.forwardPrincipal && req.access) headers[this.naming.principalHeader] = `${req.access.caller.type}:${req.access.caller.key}`;
    if (req.requestId) headers['x-request-id'] = req.requestId;

    const target = new URL(req.originalUrl, this.upstream);
    const client = target.protocol === 'https:' ? https : http;
    const upstreamReq = client.request(target, { method: req.method, headers, agent: this.agent, timeout: 120_000 }, (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) if (!STRIP_RESPONSE.has(k) && v !== undefined) out[k] = v;
      res.status(up.statusCode ?? 502);
      res.set(out);
      up.pipe(res);
    });
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (e) => {
      this.log.warn(`${req.method} ${target.pathname} → upstream error: ${e.message}`);
      if (!res.headersSent) res.status(502).json({ statusCode: 502, message: `${this.naming.serviceName} service unavailable` });
      else res.destroy();
    });
    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }
}

/** Express paths for the upstream prefixes: `/orders` → `orders` and `orders/*path`. */
export function proxyPaths(prefixes: readonly string[]): string[] {
  return prefixes.flatMap((p) => {
    const bare = p.replace(/^\/+|\/+$/g, '');
    return [bare, `${bare}/*path`];
  });
}

/**
 * The proxy controller for one product. Route paths are decorator arguments, so the class is made per product,
 * from its upstream prefixes. Registered last: its routes are prefixes owned by the upstream, the others are
 * the gateway's own API.
 */
export function createProxyController(prefixes: readonly string[], naming: GatewayNaming, forwardPrincipal: boolean): Type {
  const paths = proxyPaths(prefixes);

  @ApiExcludeController()
  @Controller()
  class ProxyController {
    private readonly handler: ProxyHandler;

    constructor(config: ConfigService) {
      this.handler = new ProxyHandler(config as unknown as ConfigService<AppConfig, true>, naming, forwardPrincipal);
    }

    @ProxyRoute()
    @All(paths)
    forward(@Req() req: GatewayRequest, @Res() res: Response) {
      this.handler.forward(req, res);
    }
  }
  return ProxyController;
}
