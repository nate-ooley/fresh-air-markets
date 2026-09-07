const DEMO_SECRET = "demo-secret-change-me";

/** Production sessions must never use the publicly known demo signing key. */
export function signingSecret(environment: { NODE_ENV?: string; AUTH_SECRET?: string }): string {
  const configured = environment.AUTH_SECRET;
  if (environment.NODE_ENV === "production"
    && (!configured?.trim() || configured === DEMO_SECRET)) {
    throw new Error("Set a private AUTH_SECRET before enabling production authentication.");
  }
  return configured || DEMO_SECRET;
}
