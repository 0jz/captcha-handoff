// MCP server entry point (stdio transport).
//
// Boots the whole pipeline: browser session manager, watchman, handoff
// coordinator, resume watcher, notifier, and the session jar, then serves the
// MCP tools over stdio.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { createSessionManager } from "./browser/session-manager.js";
import { createWatchman } from "./browser/watchman.js";
import { createCoordinator } from "./handoff/coordinator.js";
import { createResumeWatcher } from "./handoff/resume.js";
import { createNotifier } from "./notify/notifier.js";
import { createJarStore } from "./jar/store.js";
import { createServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const browser = createSessionManager(config);
  const watchman = createWatchman(browser, config);
  const coordinator = createCoordinator(config);
  const resume = createResumeWatcher(browser, coordinator, config);
  const notifier = createNotifier(config);
  const jar = createJarStore(config);

  // Attach to (or launch) Chrome in the background so the server starts serving
  // MCP immediately, then auto-connects the watchman as soon as Chrome is up
  // (and re-attaches if the human closes it mid-session).
  let lastAttachState: "attached" | "detached" | null = null;
  const maintainAttach = async (): Promise<void> => {
    for (;;) {
      try {
        await browser.attach();
        if (lastAttachState !== "attached") {
          console.error("[captcha-handoff] attached to Chrome.");
          lastAttachState = "attached";
        }
      } catch (err) {
        if (lastAttachState !== "detached") {
          console.warn(
            "[captcha-handoff] Chrome not available yet (will keep retrying):",
            err instanceof Error ? err.message : err,
          );
          lastAttachState = "detached";
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  };
  void maintainAttach();

  const server = createServer({
    config,
    browser,
    watchman,
    coordinator,
    resume,
    notifier,
    jar,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  watchman.start();
  resume.start();

  console.error(
    "[captcha-handoff] MCP server ready (stdio). " +
      `Chrome debug port ${config.chromeDebugPort}, headless=${config.headless}.`,
  );

  // Clean shutdown.
  const shutdown = async (): Promise<void> => {
    watchman.stop();
    resume.stop();
    coordinator.stop();
    await notifier.flush();
    await server.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[captcha-handoff] fatal:", err);
  process.exit(1);
});
