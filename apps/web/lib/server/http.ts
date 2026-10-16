import { addressInputSchema } from "@treecord/shared";
import { z } from "zod";
import { badRequest } from "./errors";

/** Parses a JSON body against a schema. Malformed JSON is a 400, schema failures become validation_error. */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("invalid_json", "Request body must be valid JSON");
  }
  return schema.parse(body);
}

/** Parses the query string against a schema. */
export function readQuery<T extends z.ZodType>(request: Request, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}

const uuidSchema = z.uuid();

/** Validates a UUID path segment. */
export function parseUuid(value: string, name = "id"): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw badRequest("invalid_path", `${name} must be a UUID`);
  return result.data;
}

/** Validates and lowercases an address path segment. */
export function parseAddress(value: string, name = "address"): `0x${string}` {
  const result = addressInputSchema.safeParse(value);
  if (!result.success) throw badRequest("invalid_path", `${name} must be a 0x address`);
  return result.data;
}

const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** Optional Idempotency-Key header (1 to 200 visible ASCII characters). */
export function readIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key");
  if (value === null) return undefined;
  const result = idempotencyKeySchema.safeParse(value);
  if (!result.success)
    throw badRequest(
      "invalid_idempotency_key",
      "Idempotency-Key must be 1 to 200 visible ASCII characters",
    );
  return result.data;
}
