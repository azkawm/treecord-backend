// Runs once when the Next.js server boots. Validating env here makes a misconfigured
// deployment fail at startup rather than on the first API request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("./lib/server/env");
    getServerEnv();
  }
}
