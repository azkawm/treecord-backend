// Env for route tests: the local Supabase stack (`pnpm db:start`) and anvil defaults.
// The Supabase keys are the CLI's public local-development defaults, not secrets.
const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  PUBLIC_APP_URL: "http://localhost:3000",
  BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  USDC_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ATTESTER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  SUPABASE_URL: process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:44321",
  SUPABASE_SERVICE_ROLE_KEY:
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  PRIVY_APP_ID: "test-app",
  PRIVY_APP_SECRET: "test-secret",
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] = value;
}
