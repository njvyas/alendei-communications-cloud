import type { DomainStatus, DomainType } from '@/lib/api-client';

interface DomainStatusBadgeProps {
  readonly status: DomainStatus;
  readonly isPrimary?: boolean;
}

interface DomainTypeBadgeProps {
  readonly type: DomainType;
}

export function DomainStatusBadge({ status, isPrimary }: DomainStatusBadgeProps) {
  const getBadgeStyle = () => {
    switch (status) {
      case 'active':
        return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
      case 'pending_verification':
        return 'border-amber-500/20 bg-amber-500/10 text-amber-400';
      case 'suspended':
        return 'border-neutral-500/20 bg-neutral-500/10 text-neutral-400';
      case 'revoked':
        return 'border-red-500/20 bg-red-500/10 text-red-400';
      default:
        return 'border-neutral-500/20 bg-neutral-500/10 text-neutral-400';
    }
  };

  const getLabel = () => {
    switch (status) {
      case 'active':
        return 'Active';
      case 'pending_verification':
        return 'Pending DNS Verification';
      case 'suspended':
        return 'Suspended';
      case 'revoked':
        return 'Revoked';
      default:
        return status;
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${getBadgeStyle()}`}
      >
        {getLabel()}
      </span>
      {isPrimary && (
        <span className="inline-flex items-center rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
          Primary
        </span>
      )}
    </div>
  );
}

export function DomainTypeBadge({ type }: DomainTypeBadgeProps) {
  const isSubdomain = type === 'subdomain';
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase font-medium ${
        isSubdomain
          ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
      }`}
    >
      {isSubdomain ? 'Subdomain' : 'Custom'}
    </span>
  );
}
