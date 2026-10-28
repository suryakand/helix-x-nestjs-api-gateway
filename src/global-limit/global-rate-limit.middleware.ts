import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { IpLimiterService } from './ip-limiter.service';

/** First line of defence for the gateway process itself: per-IP requests per minute, before any auth work. */
@Injectable()
export class GlobalRateLimitMiddleware implements NestMiddleware {
  constructor(private readonly limiter: IpLimiterService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const wait = await this.limiter.hit(req.ip ?? 'unknown');
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ statusCode: 429, message: 'too many requests from this address' });
      return;
    }
    next();
  }
}
