'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { UserDetailView } from '@/components/users/user-detail-view';

interface UserDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default function UserDetailPage({ params }: UserDetailPageProps) {
  const router = useRouter();
  const { id } = use(params);

  return (
    <div className="space-y-6">
      <UserDetailView userId={id} onBack={() => router.push('/users')} />
    </div>
  );
}
