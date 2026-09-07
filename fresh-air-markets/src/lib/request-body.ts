/** Accept only JSON objects; malformed JSON and scalar/array bodies are invalid. */
export async function readObjectBody(request: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
