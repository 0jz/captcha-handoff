// Zod schemas for all MCP tool inputs.
//
// These are intentionally declared without an explicit type annotation so the
// precise shape (and thus the callback argument types) survive into the server
// registration. All tool inputs are validated by the MCP SDK on call.
import { z } from "zod";

export const detectCaptchaInput = {
  tabId: z
    .string()
    .optional()
    .describe("CDP target id. Omit to scan all open tabs."),
};

export const requestHumanSolveInput = {
  sessionId: z
    .string()
    .describe("Handoff session id (from detect_captcha or get_handoff_status)."),
};

export const getHandoffStatusInput = {
  sessionId: z.string().optional().describe("Omit to list every session."),
};

export const waitForClearInput = {
  sessionId: z.string().describe("Handoff session id to wait on."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe("How long to wait before giving up (ms). Default 60000."),
};

export const solveCaptchaInput = {
  tabId: z
    .string()
    .optional()
    .describe(
      "Tab to solve (CDP target id). If sessionId is given, its tab is used.",
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Existing handoff session to solve. Takes precedence over tabId.",
    ),
};

export const saveSessionInput = {
  site: z
    .string()
    .describe("Registrable domain to persist the current verified session for."),
};

export const restoreSessionInput = {
  site: z.string().describe("Registrable domain to restore a saved session for."),
};

export const listKnownSitesInput = {};
