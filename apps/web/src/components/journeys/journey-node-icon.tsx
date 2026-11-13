import type { SVGProps } from 'react';
import type { JourneyNodeType } from '@/lib/journeys';

export interface JourneyNodeIconProps extends SVGProps<SVGSVGElement> {
  readonly type: JourneyNodeType;
  readonly className?: string;
}

export function JourneyNodeIcon({ type, className = 'h-4 w-4', ...props }: JourneyNodeIconProps) {
  switch (type) {
    case 'entry':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
    case 'send_message':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 10h8" />
          <path d="M8 14h4" />
        </svg>
      );
    case 'wait_duration':
    case 'wait_until':
    case 'wait_window':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case 'condition':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      );
    case 'wait_for_outcome':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
    case 'update_contact':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
          <path d="M16 11l2 2 4-4" />
        </svg>
      );
    case 'exit':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'webhook':
    case 'crm_action':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      );
    case 'human_handoff':
    case 'ai_handoff':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={className}
          {...props}
        >
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
  }
}

export function getNodeTypeColorClass(type: JourneyNodeType): string {
  switch (type) {
    case 'entry':
      return 'border-sky-500/50 bg-sky-500/10 text-sky-400';
    case 'send_message':
      return 'border-violet-500/50 bg-violet-500/10 text-violet-400';
    case 'wait_duration':
    case 'wait_until':
    case 'wait_window':
      return 'border-amber-500/50 bg-amber-500/10 text-amber-400';
    case 'condition':
      return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400';
    case 'wait_for_outcome':
      return 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400';
    case 'update_contact':
      return 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400';
    case 'exit':
      return 'border-rose-500/50 bg-rose-500/10 text-rose-400';
    default:
      return 'border-slate-500/50 bg-slate-500/10 text-slate-400';
  }
}
