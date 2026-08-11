/**
 * The in-memory store passes the shared GovernanceStore contract (#12 item 5):
 * its CAS/uniqueness semantics must be indistinguishable from Postgres —
 * the conductor tests lean on this fake and drift here would hide real races.
 */

import { governanceStoreContract } from "../testkit/governance-store-conformance.js";
import { InMemoryGovernanceStore } from "./in-memory-governance-store.js";

governanceStoreContract("in-memory", () => new InMemoryGovernanceStore());
