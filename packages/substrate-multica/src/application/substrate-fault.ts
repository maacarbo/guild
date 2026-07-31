import type { SubstrateError, SubstrateErrorCategory } from "@guild/shared";

/** Error subclass carrying the SubstrateError shape (checked via isSubstrateError) */
export class SubstrateFault extends Error implements SubstrateError {
  readonly category: SubstrateErrorCategory;
  readonly retryable: boolean;

  constructor(category: SubstrateErrorCategory, retryable: boolean, message: string) {
    super(message);
    this.name = "SubstrateFault";
    this.category = category;
    this.retryable = retryable;
  }
}
