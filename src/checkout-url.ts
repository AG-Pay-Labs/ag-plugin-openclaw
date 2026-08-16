const MAX_CHECKOUT_URL_LENGTH = 2_048;
const STRIPE_HOSTED_ADAPTER = "stripe-hosted";
const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";
const STRIPE_TEST_SESSION_PATH = /^\/c\/pay\/cs_test_[A-Za-z0-9]+$/;

export function validateManagedCheckoutUrl(
  adapter: string,
  value: string,
  label = "checkout_url",
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHECKOUT_URL_LENGTH ||
    /\s/.test(value)
  ) {
    throw new Error(`${label} must be a valid HTTPS URL of at most 2048 characters`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS URL without embedded credentials`);
  }

  if (adapter !== STRIPE_HOSTED_ADAPTER) {
    return;
  }
  if (
    url.hostname !== STRIPE_CHECKOUT_HOST ||
    url.port !== "" ||
    url.search !== "" ||
    !STRIPE_TEST_SESSION_PATH.test(url.pathname)
  ) {
    throw new Error(
      `${label} for stripe-hosted must be an exact Stripe test Checkout Session URL`,
    );
  }
}
