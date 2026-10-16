// Runs a command with env vars loaded from a file. Foundry only reads a .env in its own folder,
// while Treecord keeps one .env at the repo root.
//
// Usage: node script/with-env.mjs [--env <file>] <command> [args...]
// Default file: ../../.env (repo root). Variables already set in the shell win.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
let envFile = resolve(import.meta.dirname, "../../../.env");
if (args[0] === "--env") {
  envFile = resolve(process.cwd(), args[1]);
  args.splice(0, 2);
}

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
} else {
  console.warn(`with-env: ${envFile} not found, using the current environment only`);
}

if (args.length === 0) {
  console.error("with-env: no command given");
  process.exit(1);
}

const result = spawnSync(args[0], args.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
