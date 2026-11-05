'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { defaultEventSection } from '../../../../lib/admin-nav';
import { a } from '../../../../messages/admin';
import { useAdminMe } from '../../admin-shell';

/** 活動入口：依角色前往第一個可用的頁面。 */
export default function EventHome() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useAdminMe();
  useEffect(() => { router.replace(`/admin/events/${id}/${defaultEventSection(me.user.role)}`); }, [id, me.user.role, router]);
  return <main className="admin-main" aria-busy="true"><p>{a.loading}</p></main>;
}
