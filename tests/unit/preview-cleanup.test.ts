// ABOUTME: Verifies preview cleanup empties its isolated R2 bucket before deleting preview state.
// ABOUTME: Keeps cleanup retryable when object or bucket deletion fails.
import { describe, expect, it } from "vitest";
import { cleanupPreviewResources } from "../../scripts/preview-cleanup.js";

describe("preview resource cleanup", () => {
  it("deletes every preview object and its bucket before deleting the database", () => {
    const commands: string[][] = [];
    const runCommand = (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (args.includes("execute")) {
        return JSON.stringify([{
          results: [
            { object_key: "portal/evt/spk/fil/fver-deck.pdf" },
            { object_key: "events/evt/branding/logo" },
          ],
          success: true,
        }]);
      }
      return "";
    };

    cleanupPreviewResources({
      databaseName: "session-bored-pr-211",
      bucketName: "session-bored-pr-211-files",
      databaseExists: true,
      bucketExists: true,
      runCommand,
    });

    expect(commands).toEqual([
      ["npx", "wrangler", "d1", "execute", "session-bored-pr-211", "--remote", "--json", "--command", expect.any(String)],
      ["npx", "wrangler", "r2", "object", "delete", "session-bored-pr-211-files/portal/evt/spk/fil/fver-deck.pdf", "--remote"],
      ["npx", "wrangler", "r2", "object", "delete", "session-bored-pr-211-files/events/evt/branding/logo", "--remote"],
      ["npx", "wrangler", "r2", "bucket", "delete", "session-bored-pr-211-files"],
      ["npx", "wrangler", "d1", "delete", "session-bored-pr-211", "--skip-confirmation"],
    ]);
  });

  it("keeps the database when the bucket cannot be deleted so cleanup can retry", () => {
    const commands: string[][] = [];
    const runCommand = (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (args.includes("execute")) return JSON.stringify([{ results: [], success: true }]);
      if (args.includes("bucket")) throw new Error("bucket is not empty");
      return "";
    };

    expect(() => cleanupPreviewResources({
      databaseName: "session-bored-pr-211",
      bucketName: "session-bored-pr-211-files",
      databaseExists: true,
      bucketExists: true,
      runCommand,
    })).toThrow(/bucket is not empty/);

    expect(commands.some((command) => command.includes("delete") && command.includes("session-bored-pr-211"))).toBe(false);
  });
});
