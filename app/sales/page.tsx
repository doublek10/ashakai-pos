import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import SalesClient from './SalesClient';

export default async function SalesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role !== 'OWNER') redirect('/pos');

  return <SalesClient ownerName={session.name} />;
}