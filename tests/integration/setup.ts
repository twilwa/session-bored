// ABOUTME: Applies the real D1 migration before Worker integration tests execute.
// ABOUTME: Gives each isolated Workers test file the same schema production receives.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
