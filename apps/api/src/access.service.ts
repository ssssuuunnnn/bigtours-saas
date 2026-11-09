import { Inject, Injectable } from '@nestjs/common';
import { AGENCY_CODE_PATTERN, pageState, type PageState } from '@bigtours/shared';
import { DatabaseService } from './database.service.ts';
import { EncryptionService } from './encryption.service.ts';
import { DomainError } from './errors.ts';
import type { EventImages } from './storage.service.ts';

export const SESSION_COOKIE = 'bt_session';

export interface AgencyInfo {
  id: string;
  code: string;
  name: string;
  logoObjectKey: string | null;
}

export interface EventInfo {
  id: string;
  slug: string;
  name: string;
  themeColor: string;
  itinerary: unknown;
  status: string;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  defaultSubsidyAmount: number;
  defaultDependentLimit: number;
  allowDependentsOnly: boolean;
  termsVersion: number;
  hasTerms: boolean;
  paymentInstructions: string | null;
  images: EventImages;
  companyName: string;
  companyLogoKey: string | null;
  pageState: PageState;
  pageOpensAt: Date | null;
}

export interface EmployeeContext {
  agency: AgencyInfo;
  event: EventInfo;
  employee: { id: string; employeeNo: string; name: string; subsidyAmount: number; dependentLimit: number };
}

@Injectable()
export class AccessService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
  ) {}

  /** 旅行社代號來自網址路徑第一段（見 agency-path.ts）；無法辨識旅行社時回傳 NOT_FOUND，不透露旅行社是否存在。 */
  async findAgency(agencyCode: string | undefined): Promise<AgencyInfo> {
    const code = (agencyCode ?? '').trim().toLowerCase();
    if (!AGENCY_CODE_PATTERN.test(code)) throw new DomainError('NOT_FOUND');
    const { rows } = await this.db.pool.query(
      `SELECT id, code, name, logo_object_key FROM agencies WHERE code = $1 AND status = 'active'`,
      [code],
    );
    const a = rows[0];
    if (!a) throw new DomainError('NOT_FOUND');
    return { id: a.id, code: a.code, name: a.name, logoObjectKey: a.logo_object_key };
  }

  async findEvent(agencyId: string, slug: string): Promise<EventInfo> {
    const r = await this.db.withTenant(agencyId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, slug, name, itinerary, status, registration_opens_at, registration_closes_at,
                default_subsidy_amount, default_dependent_limit, allow_dependents_only, terms_version, terms_object_key, payment_instructions, hero_object_key, login_mobile_object_key, home_image_object_key,
                page_mode, page_is_open, page_opens_at, page_closes_at, theme_color,
                (SELECT c.name FROM companies c WHERE c.id = company_id) AS company_name,
                (SELECT c.logo_object_key FROM companies c WHERE c.id = company_id) AS company_logo_key,
                (SELECT a.is_trial AND a.contract_ends_on < (now() AT TIME ZONE 'Asia/Taipei')::date FROM agencies a WHERE a.id = agency_id) AS trial_expired
           FROM events WHERE slug = $1 AND status IN ('published', 'closed')`,
        [slug],
      );
      return rows[0];
    });
    if (!r) throw new DomainError('NOT_FOUND');
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      themeColor: r.theme_color,
      itinerary: r.itinerary,
      status: r.status,
      registrationOpensAt: r.registration_opens_at,
      registrationClosesAt: r.registration_closes_at,
      defaultSubsidyAmount: r.default_subsidy_amount,
      defaultDependentLimit: r.default_dependent_limit,
      allowDependentsOnly: r.allow_dependents_only,
      termsVersion: r.terms_version,
      hasTerms: r.terms_object_key !== null,
      paymentInstructions: r.payment_instructions,
      companyName: r.company_name,
      companyLogoKey: r.company_logo_key,
      images: { login: r.hero_object_key, 'login-mobile': r.login_mobile_object_key, home: r.home_image_object_key },
      // 試用到期後員工報名頁一律關閉
      pageState: r.trial_expired ? 'closed' : pageState({ mode: r.page_mode, isOpen: r.page_is_open, opensAt: r.page_opens_at, closesAt: r.page_closes_at }),
      pageOpensAt: r.page_mode === 'scheduled' ? r.page_opens_at : null,
    };
  }

  /** 活動頁關閉時，已登入的員工也不能存取。 */
  async resolve(agencyCode: string | undefined, slug: string, sessionToken: string | undefined): Promise<EmployeeContext> {
    const agency = await this.findAgency(agencyCode);
    const event = await this.findEvent(agency.id, slug);
    if (event.pageState !== 'open') throw new DomainError('PAGE_CLOSED', { pageState: event.pageState });
    if (!sessionToken) throw new DomainError('UNAUTHENTICATED');

    const r = await this.db.withTenant(agency.id, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.id, m.employee_no, m.name, m.subsidy_amount, m.dependent_limit
           FROM employee_sessions s JOIN event_employees m ON m.id = s.event_employee_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND m.event_id = $2 AND m.status = 'active'`,
        [this.encryption.hashToken(sessionToken), event.id],
      );
      return rows[0];
    });
    if (!r) throw new DomainError('UNAUTHENTICATED');
    return {
      agency,
      event,
      employee: {
        id: r.id,
        employeeNo: r.employee_no,
        name: r.name,
        subsidyAmount: r.subsidy_amount ?? event.defaultSubsidyAmount,
        dependentLimit: r.dependent_limit ?? event.defaultDependentLimit,
      },
    };
  }
}
