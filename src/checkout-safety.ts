import type { CheckoutEventRead, CheckoutExecutionStatus } from "./types.js";

const SAFE_ERROR_MESSAGES = new Map<string, string>([
  ["adapter_invalid", "the configured merchant checkout adapter is invalid"],
  ["agent_inactive", "the purchasing agent is no longer active"],
  ["amount_mismatch", "the merchant amount did not match the approved amount"],
  ["authorization_snapshot_failed", "the approved payment authorization could not be verified"],
  ["browser_navigation_failed", "the protected checkout browser could not load the merchant"],
  ["browser_session_failed", "the protected checkout browser was unavailable"],
  ["card_reference_invalid", "the approved payment reference is invalid"],
  ["card_reconciliation_required", "the approved payment method requires reconciliation in AG Pay"],
  ["card_unavailable", "the approved virtual payment card is unavailable"],
  ["cart_not_approved", "the request is no longer approved for checkout"],
  ["checkout_action_required", "the merchant requires additional human action"],
  ["checkout_disabled", "managed checkout is disabled"],
  ["checkout_failed", "the merchant checkout did not complete"],
  ["currency_mismatch", "the merchant currency did not match the approved currency"],
  ["execution_invalid", "the managed checkout is no longer valid"],
  ["item_mismatch", "the merchant item no longer matches the approved item"],
  ["origin_blocked", "checkout attempted to leave an approved merchant origin"],
  ["payment_declined", "the payment was declined"],
  ["payment_form_not_found", "the approved merchant payment form could not be located"],
  ["payment_method_unassigned", "the approved payment method is no longer assigned to the agent"],
  ["payment_method_unavailable", "the approved payment method is unavailable"],
  ["payment_outcome_unknown", "the merchant payment outcome could not be proven"],
  ["provider_unsupported", "the configured payment provider is unsupported"],
  ["quantity_mismatch", "the merchant quantity no longer matches the approved quantity"],
  ["recurring_unsupported", "managed checkout supports one-time purchases only"],
  ["total_mismatch", "the merchant total no longer matches the approved amount"],
  ["total_not_found", "the merchant checkout total could not be located"],
]);

export function safeCheckoutErrorCode(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return SAFE_ERROR_MESSAGES.has(value) ? value : "checkout_failed";
}

function safeErrorMessage(value: string | null): string {
  const code = safeCheckoutErrorCode(value);
  return (code && SAFE_ERROR_MESSAGES.get(code)) ?? "the merchant checkout did not complete";
}

export function isTerminalCheckoutStatus(status: CheckoutExecutionStatus): boolean {
  return new Set<CheckoutExecutionStatus>([
    "succeeded",
    "failed",
    "action_required",
    "outcome_unknown",
  ]).has(status);
}

export function formatSafeCheckoutOutcome(event: CheckoutEventRead): string | null {
  switch (event.status) {
    case "queued":
    case "running":
      return null;
    case "succeeded":
      return [
        `AG Pay completed checkout for purchase request ${event.request_id}.`,
        `Confirmed amount: ${event.amount} ${event.currency}.`,
        event.purchase_id ? `Purchase ID: ${event.purchase_id}.` : "",
        "The checkout was handled by the trusted AG Pay platform; no payment or browser credentials are included.",
      ]
        .filter(Boolean)
        .join(" ");
    case "failed":
      return [
        `AG Pay checkout failed for purchase request ${event.request_id}.`,
        `Safe reason: ${safeErrorMessage(event.error_code)}.`,
        "AG Pay did not report a completed purchase. Do not retry automatically.",
      ].join(" ");
    case "action_required":
      return [
        `AG Pay checkout for purchase request ${event.request_id} requires human action.`,
        `Safe reason: ${safeErrorMessage(event.error_code)}.`,
        "Do not retry or attempt to collect payment credentials; direct the user to AG Pay.",
      ].join(" ");
    case "outcome_unknown":
      return [
        `AG Pay could not determine the final checkout outcome for purchase request ${event.request_id}.`,
        "Do not retry automatically because that could create a duplicate purchase.",
        "Ask the user to inspect and reconcile the request in AG Pay.",
      ].join(" ");
  }
}
