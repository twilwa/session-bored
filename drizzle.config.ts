// ABOUTME: Configures migration generation from the authoritative D1 schema.
// ABOUTME: Writes deterministic SQL migrations consumed by Wrangler locally and remotely.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./migrations",
});
