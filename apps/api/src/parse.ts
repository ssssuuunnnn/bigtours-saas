import type { ZodType } from 'zod';
import { DomainError } from './errors.ts';

export function parse<T>(schema: ZodType<T, any, any>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError('INVALID_INPUT', { issues: result.error.issues.map((i) => i.path.join('.')) });
  return result.data;
}
