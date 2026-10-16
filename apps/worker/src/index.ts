import { pino } from "pino";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL });

logger.info({ chainId: env.CHAIN_ID, mockAi: env.MOCK_AI }, "worker started");
