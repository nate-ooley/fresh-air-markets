import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface PaymentEmailEnvelopeContext {
  id: string; marketId: string; reservationId: string; revision: number; recipientEmail: string;
}

function encryptionKey(secret: string): Buffer {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || secret.length > 4096
    || new Set(secret).size < 8 || /demo-secret|change-me|replace.?me|QA-only/i.test(secret)) {
    throw new Error("Payment email requires a strong private authentication secret");
  }
  return Buffer.from(hkdfSync("sha256", secret, "fresh-air-payment-email-v1", "invitation-encryption", 32));
}

export function validatePaymentEmailSecret(secret: string): void { encryptionKey(secret); }

function aad(context: PaymentEmailEnvelopeContext): Buffer {
  return Buffer.from(JSON.stringify([context.id, context.marketId, context.reservationId, context.revision, context.recipientEmail]));
}

/** Random nonces and identity-bound AAD prevent copy/paste across queued recipients. */
export function encryptPaymentEmailInvitation(url: string, secret: string, context: PaymentEmailEnvelopeContext): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptPaymentEmailInvitation(envelope: string, secret: string, context: PaymentEmailEnvelopeContext): string {
  const [version, nonce, tag, ciphertext, extra] = envelope.split(".");
  if (version !== "v1" || extra !== undefined || !nonce || !tag || !ciphertext || envelope.length > 4096
    || Buffer.from(nonce, "base64url").length !== 12 || Buffer.from(tag, "base64url").length !== 16) {
    throw new Error("Payment email invitation is unavailable");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(nonce, "base64url"));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
