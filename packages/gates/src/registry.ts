import { validateGateAdapter, type GateAdapter } from "@gatecrusher/core";
import type { BrowserGateAdapter } from "./context.ts";
import { createNativeAdapter } from "./native/adapter.ts";

export interface AdapterRegistry<TAdapter extends GateAdapter<never>> {
  /** Every adapter, highest priority first. */
  readonly adapters: readonly TAdapter[];
  /** The highest-priority adapter whose `detect` matches, or `null`. */
  resolve(url: URL): TAdapter | null;
}

/**
 * Builds a registry, refusing malformed adapters and duplicate ids up front: step names
 * and adapter ids are stored in the database, so they must be unambiguous.
 */
export function createRegistry<TAdapter extends GateAdapter<never>>(
  adapters: readonly TAdapter[],
): AdapterRegistry<TAdapter> {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    const validation = validateGateAdapter(adapter);
    if (!validation.ok) {
      throw new Error(`Invalid gate adapter "${adapter.id}": ${validation.reason}`);
    }
    if (seen.has(adapter.id)) throw new Error(`Duplicate gate adapter id "${adapter.id}"`);
    seen.add(adapter.id);
  }

  const byPriority = [...adapters].sort((a, b) => b.priority - a.priority);
  return {
    adapters: byPriority,
    resolve: (url) => byPriority.find((adapter) => adapter.detect(url)) ?? null,
  };
}

/**
 * The adapters the worker runs. Hypeddit joins in slice 4; the AI browser agent, with
 * the lowest priority, in slice 5.
 */
export const registry: AdapterRegistry<BrowserGateAdapter> = createRegistry([
  createNativeAdapter(),
]);
