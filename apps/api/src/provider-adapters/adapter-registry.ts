import { PROVIDER_ADAPTER_KEYS } from '@acc/contracts';

import { assertGuardedAdapter, type GuardedProviderAdapter } from './circuit-admission';

/** `adapter_key` names no registered adapter. Fail closed; the caller decides the status. */
export class ProviderAdapterNotRegistered extends Error {
  constructor(readonly adapterKey: string) {
    super(`No provider adapter is registered for key "${adapterKey}"`);
    this.name = 'ProviderAdapterNotRegistered';
  }
}

/**
 * `adapter_key → adapter` (ADR-013 F-9). Built once, from code, by the
 * submission executor that owns it — it is not a DI provider, and the executor
 * holds it in an ES private field, so nothing else can reach an adapter
 * (ADR-015 R-13). Nothing a request carries can register, replace or name an
 * adapter that is not here, and a provider's key comes from its catalogue row,
 * never from input.
 *
 * Construction fails if an adapter cannot be trusted to enforce the submission
 * permit (not a `GuardedProviderAdapter`, overriding `send()`, or not frozen),
 * if two adapters claim one key (so registration order can never decide which
 * one wins), or if the registered set and the published `PROVIDER_ADAPTER_KEYS`
 * disagree in either direction.
 */
export class ProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, GuardedProviderAdapter>;

  constructor(adapters: readonly GuardedProviderAdapter[]) {
    const map = new Map<string, GuardedProviderAdapter>();
    for (const adapter of adapters) {
      assertGuardedAdapter(adapter);
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
    this.#adapters = map;
    Object.freeze(this);
  }

  /** The adapter for `adapterKey`, or `ProviderAdapterNotRegistered`. For the executor only. */
  resolve(adapterKey: string): GuardedProviderAdapter {
    const adapter = this.#adapters.get(adapterKey);
    if (!adapter) throw new ProviderAdapterNotRegistered(adapterKey);
    return adapter;
  }

  keys(): readonly string[] {
    return [...this.#adapters.keys()];
  }
}
