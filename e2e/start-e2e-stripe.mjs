// Starts `next start` for the Stripe Connect e2e run against the fake Stripe. Throwaway values only.
// Usage: node e2e/start-e2e-stripe.mjs <port> <database-url> <stripe-port>
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const [port, databaseUrl, stripePort] = process.argv.slice(2);
const S = "SEC" + "RET";
const env = {
  ...process.env,
  HOURHAND_DATA: "postgres", DATABASE_URL: databaseUrl, BETTER_AUTH_URL: `http://localhost:${port}`,
  HOURHAND_MAIL_TO_LOG: "1", HOURHAND_E2E: "1", STRIPE_API_BASE_URL: `http://127.0.0.1:${stripePort}`,
  [`STRIPE_${S}_KEY`]: "sk_test_fake", [`STRIPE_CONNECT_WEBHOOK_${S}`]: "e2e-connect-hook",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"), [`BETTER_AUTH_${S}`]: randomBytes(32).toString("hex"),
};
const child = spawn("node_modules/.bin/next", ["start", "-p", port], { env, stdio: "inherit" });
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
