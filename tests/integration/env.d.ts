// ABOUTME: Extends generated Worker bindings with migration data injected by the test runner.
// ABOUTME: Keeps integration-only configuration out of the production binding contract.
export {};

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    }
  }
}
