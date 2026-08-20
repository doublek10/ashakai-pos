'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import PosScreen from './PosScreen';

interface Branch {
  id: string;
  name: string;
}

export default function PosPageClient({ cashierName, role }: { cashierName: string; role: string }) {
  const [branch, setBranch] = useState<Branch | null | 'loading'>('loading');

  useEffect(() => {
    apiFetch<{ branches: Branch[] }>('/api/branches')
      .then((data) => setBranch(data.branches[0] ?? null))
      .catch(() => setBranch(null));
  }, []);

  if (branch === 'loading') {
    return <div className="p-8 text-sm text-ink/60">Loading…</div>;
  }

  if (!branch) {
    return <div className="p-8 text-sm text-ink/60">No branch configured yet. Ask the owner to set one up.</div>;
  }

  return <PosScreen cashierName={cashierName} branchId={branch.id} role={role} />;
}