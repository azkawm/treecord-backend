import { hostname } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { Attester, createAiClient, type Db } from "@treecord/pipeline";
import { getDeployment, type Database } from "@treecord/shared";
import type { Hex } from "viem";
import { pino } from "pino";
import { createChainClients } from "./chain.js";
import { loadEnv } from "./env.js";
import { startHttpServer } from "./server.js";
import { Worker } from "./worker.js";

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });

const deployment = getDeployment(env.CHAIN_ID);
const db: Db = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const clients = createChainClients({
  rpcUrl: env.BASE_SEPOLIA_RPC_URL,
  chainId: env.CHAIN_ID,
  operatorKey: env.OPERATOR_PRIVATE_KEY as Hex,
  relayerKey: env.RELAYER_PRIVATE_KEY as Hex,
});
const chainNow = async () =>
  Number((await clients.public.getBlock({ blockTag: "latest" })).timestamp);

const worker = new Worker({
  mode: env.WORKER_MODE,
  db,
  clients,
  deployment,
  log,
  workerId: `${hostname()}:${process.pid}`,
  scoreDeps: {
    db,
    attester: new Attester(
      env.ATTESTER_PRIVATE_KEY as Hex,
      env.CHAIN_ID,
      deployment.verificationGateway,
    ),
    chainNow,
    ai: createAiClient(env),
    log,
  },
  indexer: {
    pollMs: env.INDEXER_POLL_MS,
    chunkBlocks: env.INDEXER_CHUNK_BLOCKS,
    confirmations: env.INDEXER_CONFIRMATIONS,
    rescanBlocks: env.INDEXER_RESCAN_BLOCKS,
    ...(env.INDEXER_START_BLOCK !== undefined
      ? { startBlock: BigInt(env.INDEXER_START_BLOCK) }
      : {}),
  },
  relayer: { pollMs: env.RELAYER_POLL_MS },
  scheduler: { intervalMs: env.SCHEDULER_INTERVAL_MS },
});

const server = await startHttpServer({
  port: env.PORT,
  health: () => worker.health(),
  metrics: () => worker.metrics.snapshot(),
});
log.info(
  {
    chainId: env.CHAIN_ID,
    mode: env.WORKER_MODE,
    mockAi: env.MOCK_AI,
    port: env.PORT,
    operator: clients.operator.account.address,
    relayer: clients.relayer.account.address,
  },
  "worker listening",
);
worker.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  server.close();
  await worker.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
