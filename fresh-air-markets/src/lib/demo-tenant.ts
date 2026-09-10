/**
 * The public demo tenant (demo@freshairmarkets.app / sunrise-demo) exists for
 * local development and Preview only. Production never seeds it and never
 * accepts its login, even if a database was seeded before this rule existed.
 */
export function demoTenantAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV !== "production";
}
