// Small HTTP server for Railway health checks and basic monitoring.
import { createServer, type Server } from "node:http";

export type HealthReport = { ok: boolean } & Record<string, unknown>;

export function startHttpServer(options: {
  port: number;
  health: () => HealthReport;
  metrics: () => unknown;
}): Promise<Server> {
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "GET") return send(405, { error: "method_not_allowed" });
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/health") {
      const report = options.health();
      return send(report.ok ? 200 : 503, report);
    }
    if (path === "/metrics") return send(200, options.metrics());
    return send(404, { error: "not_found" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => resolve(server));
  });
}
