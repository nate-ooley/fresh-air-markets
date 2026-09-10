import { squareSandboxSetupConfig, verifySquareSandboxSetup } from "../src/lib/square.ts";

async function main() {
  const identity = await verifySquareSandboxSetup(squareSandboxSetupConfig(process.env));
  // The merchant and location IDs are identifiers, not access credentials.
  // Never print the access token or any provider response body.
  console.log(`Square Sandbox verified\nMerchant ID: ${identity.merchantId}\nLocation ID: ${identity.locationId}`);
}

void main().catch(() => {
  console.error("Square Sandbox verification failed. Check the private Sandbox token and location variables.");
  process.exitCode = 1;
});
