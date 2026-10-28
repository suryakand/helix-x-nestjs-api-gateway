import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AccessContext, GatewayRequest } from './request-context';

export const IS_PUBLIC = 'gw:public';
export const ACCESS_MODE = 'gw:mode';

/** No credentials needed (health, docs). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Gateway management API: signed-in users only; M2M client tokens are refused. */
export const JwtOnly = () => SetMetadata(ACCESS_MODE, 'jwt-only');
/** Any valid token (user or client); no tenant, permission or quota. */
export const Authenticated = () => SetMetadata(ACCESS_MODE, 'any');
/** Proxied upstream route: user or client token, permission check via access-policy, metered. */
export const ProxyRoute = () => SetMetadata(ACCESS_MODE, 'proxy');

export const Access = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessContext => {
  const req = ctx.switchToHttp().getRequest<GatewayRequest>();
  return req.access!;
});
