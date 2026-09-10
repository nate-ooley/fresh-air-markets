const DEMO_SECRET = "demo-secret-change-me";
export const MIN_SECRET_LENGTH = 32;

/**
 * Production sessions must never use the publicly known demo signing key, and
 * the same >=32 character rule applies everywhere the secret is consumed
 * (session cookies, the inquiry limiter, payment email links).
 */
export function signingSecret(environment: { NODE_ENV?: string; AUTH_SECRET?: string }): string {
  const configured = environment.AUTH_SECRET;
  if (environment.NODE_ENV === "production"
    && (!configured?.trim() || configured === DEMO_SECRET || configured.trim().length < MIN_SECRET_LENGTH)) {
    throw new Error("Set a private AUTH_SECRET of at least 32 characters before enabling production authentication.");
  }
  return configured || DEMO_SECRET;
}
