'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ContactProfileView } from '@/components/contacts/contact-profile-view';

interface ContactDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default function ContactDetailPage({ params }: ContactDetailPageProps) {
  const router = useRouter();
  const { id } = use(params);

  return (
    <div className="space-y-6">
      <ContactProfileView contactId={id} onBack={() => router.push('/contacts')} />
    </div>
  );
}
