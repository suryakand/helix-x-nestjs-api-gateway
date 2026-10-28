import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessContext } from '../access/request-context';
import { AdminAudit } from '../database/entities';

/** Append-only trail of changes made through the admin API. Never stores secrets or tokens. */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(@InjectRepository(AdminAudit) private readonly repo: Repository<AdminAudit>) {}

  async record(a: AccessContext, action: string, tenantId: string | null, target: string | null, detail?: Record<string, unknown>) {
    await this.repo
      .save(this.repo.create({
        actorKey: a.caller.key, actorLabel: a.caller.label.slice(0, 255), tenantId, action, target: target?.slice(0, 255) ?? null, detail: detail ?? null,
      }))
      .catch((e) => this.log.warn(`audit not written (${action}): ${(e as Error).message}`));
  }

  list(tenantId: string, limit: number): Promise<AdminAudit[]> {
    return this.repo.find({ where: { tenantId }, order: { ts: 'DESC' }, take: Math.min(Math.max(limit, 1), 500) });
  }
}
