// ExecutionSubstrate adapter over Multica's REST/WS API (PAT auth) — the
// anti-corruption layer of D8. Composition root: wire the fetch adapter into
// the substrate service; everything exported speaks @guild/shared language.

import type { ExecutionSubstrate } from "@guild/shared";
import { MulticaSubstrate, type MulticaSubstrateConfig } from "./application/multica-substrate.js";
import { FetchMulticaApi, type FetchMulticaApiConfig } from "./adapters/fetch-multica-api.js";

export type { MulticaSubstrateConfig, RoleBinding } from "./application/multica-substrate.js";
export type { FetchMulticaApiConfig } from "./adapters/fetch-multica-api.js";
export { MulticaSubstrate } from "./application/multica-substrate.js";
export { FetchMulticaApi } from "./adapters/fetch-multica-api.js";
export { SubstrateFault } from "./application/substrate-fault.js";

export function createMulticaSubstrate(
  api: FetchMulticaApiConfig,
  config: MulticaSubstrateConfig,
): ExecutionSubstrate {
  return new MulticaSubstrate(new FetchMulticaApi(api), config);
}
