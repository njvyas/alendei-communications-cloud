import { Inject, Injectable } from '@nestjs/common';
import { PROVIDER_ADAPTER_KEYS, type ProviderAdapter } from '@acc/contracts';

export const PROVIDER_ADAPTERS = Symbol('PROVIDER_ADAPTERS');

/** `adapter_key` names no registered adapter. Fail closed; the caller decides the status. */
export class ProviderAdapterNotRegistered extends Error {
  constructor(readonly adapterKey: string) {
    super(`No provider adapter is registered for key "${adapterKey}"`);
    this.name = 'ProviderAdapterNotRegistered';
  }
}

/**
 * `adapter_key → adapter` (ADR-013 F-9). Built once, from code, at startup:
 * nothing a request carries can register, replace or name an adapter that is not
 * here, and a provider's key comes from its catalogue row, never from input.
 *
 * Construction fails if two adapters claim one key (so registration order can
 * never decide which one wins) or if the registered set and the published
 * `PROVIDER_ADAPTER_KEYS` disagree in either direction.
 */
@Injectable()
export class ProviderAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, ProviderAdapter>;

  constructor(@Inject(PROVIDER_ADAPTERS) adapters: readonly ProviderAdapter[]) {
    const map = new Map<string, ProviderAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.adapterKey)) {
        throw new Error(`Provider adapter key "${adapter.adapterKey}" is registered twice`);
      }
      map.set(adapter.adapterKey, adapter);
    }
    const published = [...PROVIDER_ADAPTER_KEYS].sort();
    const registered = [...map.keys()].sort();
    if (JSON.stringify(published) !== JSON.stringify(registered)) {
      throw new Error(
        `Registered adapters [${registered.join(', ')}] do not match PROVIDER_ADAPTER_KEYS [${published.join(', ')}]`,
      );
    }
    this.adapters = map;
  }

  /** The adapter for `adapterKey`, or `ProviderAdapterNotRegistered`. */
  resolve(adapterKey: string): ProviderAdapter {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter) throw new ProviderAdapterNotRegistered(adapterKey);
    return adapter;
  }

  keys(): readonly string[] {
    return [...this.adapters.keys()];
  }
}
