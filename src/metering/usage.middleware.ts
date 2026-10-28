import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { GatewayRequest } from '../access/request-context';
import { gatewayOptions } from '../options';
import { UsageRecorder } from './usage-recorder.service';

/**
 * Applied to the proxied upstream routes only. Hooks `finish` so rejections by the guard (401/403/429) are
 * recorded too. Records ids and the route template, never headers — so tokens and secrets cannot leak here.
 */
@Injectable()
export class UsageMiddleware implements NestMiddleware {
  constructor(private readonly recorder: UsageRecorder) {}

  use(req: GatewayRequest, res: Response, next: NextFunction) {
    req.startedAt = Date.now();
    req.requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.on('finish', () => {
      const a = req.access;
      const path = req.originalUrl.split('?')[0];
      this.recorder.record({
        ts: new Date(req.startedAt!),
        tenantId: a?.tenant?.id ?? null,
        // A platform admin outside their own tenants is logged as ADMIN (never metered).
        principalType: a ? (a.member === false ? 'ADMIN' : a.caller.type) : null,
        principalKey: a?.caller.key ?? null,
        principalLabel: a?.caller.label.slice(0, 255) ?? null,
        authType: a?.authType ?? null,
        method: req.method,
        endpoint: a?.endpoint ?? gatewayOptions().policy.resolveRoute(req.method, path)?.pattern ?? 'UNMATCHED',
        path: path.slice(0, 500),
        responseStatus: res.statusCode,
        durationMs: Date.now() - req.startedAt!,
        clientIp: req.ip ?? null,
      });
    });
    next();
  }
}
