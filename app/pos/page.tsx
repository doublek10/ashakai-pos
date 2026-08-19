import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import PosPageClient from './components/PosPageClient';

export default async function PosPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  // Branch resolution now happens client-side via apiFetch('/api/branches')
  // (see PosPageClient) instead of a direct prisma call here — a direct
  // prisma.branch.findFirst() on the server breaks in gateway mode, since
  // DATABASE_URL is intentionally not set when the DB is only reachable
  // through the PHP gateway on cPanel.
  return <PosPageClient cashierName={session.name} />;
}