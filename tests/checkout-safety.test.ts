import { describe, expect, it } from "vitest";

import {
  formatSafeCheckoutOutcome,
  safeCheckoutErrorCode,
} from "../src/checkout-safety.js";

import { checkoutEvent } from "./fixtures.js";

describe("checkout outcome safety", () => {
  it.each([
    ["item_mismatch", "approved item"],
    ["quantity_mismatch", "approved quantity"],
    ["recurring_unsupported", "one-time purchases"],
    ["authorization_snapshot_failed", "authorization could not be verified"],
    ["card_reconciliation_required", "requires reconciliation in AG Pay"],
  ])(
    "allowlists the fixed %s reason code",
    (errorCode, safePhrase) => {
      expect(safeCheckoutErrorCode(errorCode)).toBe(errorCode);
      const message = formatSafeCheckoutOutcome(
        checkoutEvent({ status: "failed", purchase_id: null, error_code: errorCode }),
      );
      expect(message).toContain(safePhrase);
    },
  );

  it("collapses every unknown backend reason to the generic safe code", () => {
    expect(safeCheckoutErrorCode("provider_secret_stacktrace")).toBe("checkout_failed");
  });
});
