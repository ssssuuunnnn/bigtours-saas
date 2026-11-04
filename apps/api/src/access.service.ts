import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, type Tx } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';

export interface EmployeeContext {
  agency: { id: string; code: string; name: string; logoObjectKey: string | null; primaryColor: string | null };
  event: {
    id: string;
    slug: string;
    name: string;
    itinerary: unknown;
    status: string;
    registrationOpensAt: Date | null;
    registrationClosesAt: Date | null;
    defaultSubsidyAmount: number;
    defaultDependentLimit: number;
    allowDependentsOnly: boolean;
    termsVersion: number;
  };
  employee: { id: string; employeeNo: string; name: string; subsidyAmount: number; dependentLimit: number };
}

@Injectable()
export class AccessService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
  ) {}

  /** 由網址判定旅行社：abc-travel.平台網域 */
  agencyCodeFromHost(host: string | undefined): string {
    const hostname = (host ?? '').split(',')[0]!.trim().split(':')[0]!.toLowerCase();
    const suffix = `.${process.env.PLATFORM_DOMAIN}`;
    if (!hostname.endsWith(suffix)) throw new DomainError('NOT_FOUND');
    const code = hostname.slice(0, -suffix.length);
    if (!code || code.includes('.')) throw new DomainError('NOT_FOUND');
    return code;
  }

  /** 無法辨識時一律回傳 NOT_FOUND，不透露旅行社、活動或員工是否存在。 */
  async resolve(host: string | undefined, slug: string, token: string | undefined): Promise<EmployeeContext> {
    if (!token) throw new DomainError('NOT_FOUND');
    const code = this.agencyCodeFromHost(host);
    const { rows } = await this.db.pool.query(
      `SELECT id, code, name, logo_object_key, primary_color FROM agencies WHERE code = $1 AND status = 'active'`,
      [code],
    );
    const a = rows[0];
    if (!a) throw new DomainError('NOT_FOUND');

    return this.db.withTenant(a.id, async (tx: Tx) => {
      const { rows: found } = await tx.query(
        `SELECT e.id AS event_id, e.slug, e.name AS event_name, e.itinerary, e.status, e.registration_opens_at,
                e.registration_closes_at, e.default_subsidy_amount, e.default_dependent_limit,
                e.allow_dependents_only, e.terms_version,
                m.id AS employee_id, m.employee_no, m.name AS employee_name, m.subsidy_amount, m.dependent_limit
           FROM event_employees m JOIN events e ON e.id = m.event_id
          WHERE m.link_token_hash = $1 AND m.status = 'active' AND e.slug = $2
            AND e.status IN ('published', 'closed')`,
        [this.encryption.hashToken(token), slug],
      );
      const r = found[0];
      if (!r) throw new DomainError('NOT_FOUND');
      return {
        agency: { id: a.id, code: a.code, name: a.name, logoObjectKey: a.logo_object_key, primaryColor: a.primary_color },
        event: {
          id: r.event_id,
          slug: r.slug,
          name: r.event_name,
          itinerary: r.itinerary,
          status: r.status,
          registrationOpensAt: r.registration_opens_at,
          registrationClosesAt: r.registration_closes_at,
          defaultSubsidyAmount: r.default_subsidy_amount,
          defaultDependentLimit: r.default_dependent_limit,
          allowDependentsOnly: r.allow_dependents_only,
          termsVersion: r.terms_version,
        },
        employee: {
          id: r.employee_id,
          employeeNo: r.employee_no,
          name: r.employee_name,
          subsidyAmount: r.subsidy_amount ?? r.default_subsidy_amount,
          dependentLimit: r.dependent_limit ?? r.default_dependent_limit,
        },
      };
    });
  }
}
