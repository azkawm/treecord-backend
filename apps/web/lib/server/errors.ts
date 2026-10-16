import { ZodError } from "zod";

/** Error with an HTTP status and a stable machine-readable code. Thrown by handlers, rendered by `route`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = (code = "unauthorized", message = "Authentication required") =>
  new ApiError(401, code, message);
export const forbidden = (
  code = "forbidden",
  message = "You do not have access to this resource",
) => new ApiError(403, code, message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);

/** JSON response that serializes bigint as a decimal string. Money never leaves the API as a JS number. */
export function json(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(body, { ...init, headers });
}

/** Renders any thrown value as `{ error: { code, message, details } }` with the right status. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details ?? null } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return json(
      { error: { code: "validation_error", message: "Invalid request", details } },
      { status: 400 },
    );
  }
  console.error("Unhandled API error", error);
  return json(
    { error: { code: "internal_error", message: "Something went wrong", details: null } },
    { status: 500 },
  );
}

/** Wraps a route handler so every thrown error becomes a typed JSON error response. */
export function route<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
