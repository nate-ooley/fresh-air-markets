import postgres from "postgres";
import { MAX_APPLICATION_DOCUMENT_BYTES } from "./application-document";
import type { PrivateDocumentObjectStore } from "./private-document-transfer";

type Sql = ReturnType<typeof postgres>;
let client: Sql | undefined;

function configuredClient(): Sql {
  if (!process.env.DATABASE_URL) throw new Error("Persistent document storage is required.");
  client ??= postgres(process.env.DATABASE_URL, { max: 3, prepare: false, connect_timeout: 5 });
  return client;
}

export interface PrivateDocumentObject {
  contentType: string;
  sizeBytes: number;
  body: Buffer;
}

export interface PostgresPrivateDocumentStore extends PrivateDocumentObjectStore {
  get(storageKey: string): Promise<PrivateDocumentObject | null>;
}

/**
 * Private document bytes stored in PostgreSQL (migration 022). Objects are
 * addressed only by the server-generated storage key recorded in the document
 * ledger; there is no public URL. Vendor documents are small (10 MiB ceiling)
 * and few, so the database is the simplest private store with no extra
 * provider or credential.
 */
export function postgresPrivateDocumentStore(sql: Sql = configuredClient()): PostgresPrivateDocumentStore {
  return {
    async put({ storageKey, contentType, body }) {
      const chunks: Buffer[] = [];
      let size = 0;
      // Errors thrown by the inspected stream (too large, source failure) must
      // propagate unchanged so the transfer primitive can classify them.
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > MAX_APPLICATION_DOCUMENT_BYTES) throw new Error("file_too_large");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      // An empty object cannot satisfy the ledger; validation rejects it and
      // asks for removal, which is a no-op when nothing was written.
      if (bytes.byteLength === 0) return;
      const type = contentType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
      await sql`
        INSERT INTO fame_private_document_objects (storage_key, content_type, size_bytes, body)
        VALUES (${storageKey}, ${type}, ${bytes.byteLength}, ${bytes})`;
    },
    async remove(storageKey) {
      await sql`DELETE FROM fame_private_document_objects WHERE storage_key = ${storageKey}`;
    },
    async get(storageKey) {
      const [row] = await sql<{ content_type: string; size_bytes: string | number; body: Buffer }[]>`
        SELECT content_type, size_bytes, body FROM fame_private_document_objects WHERE storage_key = ${storageKey}`;
      return row ? { contentType: row.content_type, sizeBytes: Number(row.size_bytes), body: Buffer.from(row.body) } : null;
    },
  };
}
