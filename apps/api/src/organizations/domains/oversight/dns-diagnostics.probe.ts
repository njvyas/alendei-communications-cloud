import * as dns from 'node:dns/promises';
import { Injectable } from '@nestjs/common';

/** One resolver the diagnostics consult. `servers: null` is the platform's own resolver. */
export interface DnsResolverSpec {
  readonly label: string;
  readonly servers: readonly string[] | null;
}

/**
 * The platform's own resolver comes first: it is the one U12 verification
 * actually uses (`DomainsService.verifyDomain` → `dns.resolveTxt`). The public
 * resolvers show whether the record has propagated beyond it.
 */
export const DEFAULT_DNS_RESOLVERS: readonly DnsResolverSpec[] = Object.freeze([
  { label: 'Platform resolver (used by verification)', servers: null },
  { label: 'Cloudflare (1.1.1.1)', servers: ['1.1.1.1'] },
  { label: 'Google (8.8.8.8)', servers: ['8.8.8.8'] },
  { label: 'Quad9 (9.9.9.9)', servers: ['9.9.9.9'] },
]);

/** Per-resolver bound, so one slow resolver cannot hold the request. */
export const DNS_LOOKUP_TIMEOUT_MS = 3000;

export type TxtLookup = (resolver: DnsResolverSpec, host: string) => Promise<string[][]>;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const defaultLookup: TxtLookup = (resolver, host) => {
  if (resolver.servers === null) {
    return withTimeout(dns.resolveTxt(host), DNS_LOOKUP_TIMEOUT_MS);
  }
  const r = new dns.Resolver({ timeout: DNS_LOOKUP_TIMEOUT_MS, tries: 1 });
  r.setServers([...resolver.servers]);
  return withTimeout(r.resolveTxt(host), DNS_LOOKUP_TIMEOUT_MS + 500);
};

/**
 * TXT lookups for the DNS diagnostics. Read-only: it queries DNS and changes
 * nothing, in ACC or in DNS. Replaceable in tests, as U12's resolver is.
 */
@Injectable()
export class DnsDiagnosticsProbe {
  private lookup: TxtLookup = defaultLookup;
  private resolvers: readonly DnsResolverSpec[] = DEFAULT_DNS_RESOLVERS;

  /** Test seam: substitute the lookup and, optionally, the resolver list. */
  configure(lookup: TxtLookup, resolvers: readonly DnsResolverSpec[] = this.resolvers): void {
    this.lookup = lookup;
    this.resolvers = resolvers;
  }

  list(): readonly DnsResolverSpec[] {
    return this.resolvers;
  }

  txt(resolver: DnsResolverSpec, host: string): Promise<string[][]> {
    return this.lookup(resolver, host);
  }
}
