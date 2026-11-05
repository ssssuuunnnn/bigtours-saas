import { can, type EventNavKey } from '@bigtours/shared';
import { a } from '../messages/admin';

export const AGENCY_SECTIONS = ['companies', 'staff', 'data-log', 'settings'] as const;
export type AgencySection = (typeof AGENCY_SECTIONS)[number];

const SECTION_PERMISSION = {
  companies: 'configureEvents',
  staff: 'manageAgency',
  'data-log': 'viewSensitiveData',
  settings: 'manageAgency',
} as const;

export const canSeeAgencySection = (role: string, section: AgencySection) => can(role, SECTION_PERMISSION[section]);

/** 活動選單分類。 */
export const EVENT_NAV_CATEGORIES: { label: string; items: EventNavKey[] }[] = [
  { label: a.navCategories.setup, items: ['basic', 'schedule', 'sessions', 'types', 'options', 'fields', 'payment-terms', 'contacts', 'publish'] },
  { label: a.navCategories.operations, items: ['overview', 'roster', 'registrations', 'emails'] },
  { label: a.navCategories.travel, items: ['rooms', 'export'] },
];

/** 營運人員只看得到這些項目，選單不分類。 */
export const OPERATIONS_NAV: EventNavKey[] = ['overview', 'registrations', 'rooms', 'export'];

export const usesFullEventNav = (role: string) => can(role, 'configureEvents');

export const canSeeEventSection = (role: string, section: EventNavKey) =>
  usesFullEventNav(role) || OPERATIONS_NAV.includes(section);

export const defaultEventSection = (role: string): EventNavKey => (usesFullEventNav(role) ? 'basic' : 'overview');
