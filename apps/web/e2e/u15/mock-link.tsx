import type { AnchorHTMLAttributes, ReactNode } from 'react';

export default function Link({
  href,
  children,
  ...props
}: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
