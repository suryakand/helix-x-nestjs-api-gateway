import 'reflect-metadata';
import { DynamicModule, Logger, Type, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { AppConfig } from './config/configuration';
import { gatewayOptions } from './options';

/** What `bootstrapGateway` shows in Swagger and the startup log. */
export interface BootstrapOptions {
  /** Swagger title, e.g. `Acme Orders API Gateway`. */
  title: string;
  /** One sentence on what the upstream does; the token instructions are appended. */
  description: string;
  /** Swagger version. Default npm_package_version. */
  version?: string;
  /** Merge the upstream's `/api-json` paths into the gateway's document. Default true. */
  mergeUpstreamDoc?: boolean;
  /** Called with the app before it listens, e.g. to add middleware. */
  configure?: (app: NestExpressApplication) => void | Promise<void>;
}

/**
 * Adds the upstream's own OpenAPI paths so one document describes the product. Upstream operations accept a
 * user's or an M2M client's Keycloak token. Best effort: if the upstream is down at boot, only the gateway's
 * endpoints are documented.
 */
async function mergeUpstreamDoc(doc: OpenAPIObject, upstreamUrl: string, isUpstream: (p: string) => boolean, log: Logger) {
  try {
    const res = await fetch(`${upstreamUrl}/api-json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const up = (await res.json()) as OpenAPIObject;
    for (const [path, item] of Object.entries(up.paths ?? {})) {
      if (!isUpstream(path.replace(/\{[^}]+\}/g, 'x'))) continue;
      for (const op of Object.values(item as Record<string, { security?: unknown[] }>)) {
        if (op && typeof op === 'object') op.security = [{ keycloak: [] }];
      }
      doc.paths[path] = item;
    }
    doc.components = doc.components ?? {};
    doc.components.schemas = { ...(up.components?.schemas ?? {}), ...(doc.components.schemas ?? {}) };
    doc.tags = [...(doc.tags ?? []), ...(up.tags ?? [])];
  } catch (e) {
    log.warn(`upstream OpenAPI not merged (${(e as Error).message}); Swagger shows gateway endpoints only`);
  }
}

/**
 * Creates and starts the gateway app: CORS, raw bodies for proxied paths, validation, Swagger at `/api`
 * (document at `/api-json`) and `GATEWAY_PORT`. `appModule` is `GatewayModule.forRoot(...)` itself, or a module
 * that imports it.
 */
export async function bootstrapGateway(appModule: Type | DynamicModule, opts: BootstrapOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(appModule, { bodyParser: false });
  const config = app.get(ConfigService<AppConfig, true>);
  const { policy, naming } = gatewayOptions();
  const log = new Logger('Bootstrap');
  app.enableShutdownHooks();
  app.set('trust proxy', config.get('trustProxy', { infer: true }));
  app.enableCors({
    origin: config.get('corsOrigins', { infer: true }),
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After', 'x-request-id'],
  });
  // Proxied calls keep their raw body stream; only the gateway's own API parses JSON.
  const parseJson = json({ limit: '100kb' });
  app.use((req: { path: string }, res: unknown, next: () => void) =>
    policy.isUpstream(req.path) ? next() : parseJson(req as never, res as never, next));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await opts.configure?.(app);

  const tokenUrl = config.get('keycloak', { infer: true }).tokenUrl;
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(opts.title)
      .setDescription(
        `${opts.description} Every call carries a Keycloak access token ` +
          '(`Authorization: Bearer`). Systems use their tenant\'s M2M client: `POST ' + tokenUrl + '` with ' +
          '`grant_type=client_credentials`, `client_id` and `client_secret`. People sign in through the web UI; a user ' +
          'in several tenants also sends `x-tenant-id`. Calls are metered per user and per client: see the ' +
          '`X-RateLimit-*` response headers.',
      )
      .setVersion(opts.version ?? process.env.npm_package_version ?? '0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'keycloak')
      .build(),
  );
  if (opts.mergeUpstreamDoc ?? true) {
    await mergeUpstreamDoc(doc, config.get('upstreamUrl', { infer: true }), (p) => policy.isUpstream(p), log);
  }
  SwaggerModule.setup('api', app, doc, { jsonDocumentUrl: 'api-json' });

  const port = config.get('port', { infer: true });
  await app.listen(port);
  log.log(`${naming.serviceName} gateway listening on :${port} → ${config.get('upstreamUrl', { infer: true })} — Swagger UI /api`);
  return app;
}
