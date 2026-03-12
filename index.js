#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { resolve } from "path";

const AGENT_PATH =
  process.env.CURSOR_AGENT_PATH ||
  `${process.env.HOME}/.local/bin/agent`;

const DEFAULT_TIMEOUT_S = 120;
const MAX_BUFFER = 1024 * 1024 * 10; // 10 MB

const DEFAULT_REVIEW_PROMPT = `You are a senior code reviewer. Review this code for:
- Bugs and logic errors
- Security vulnerabilities
- Performance issues
- Code quality and readability
Be concise. Only flag real issues, not style preferences.`;

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function runAgent(prompt, { model, mode = "ask", timeout }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--trust", "--mode", mode];
    if (model) args.push("--model", model);
    args.push(prompt);

    execFile(
      AGENT_PATH,
      args,
      {
        timeout,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            reject(new Error(`Cursor agent timed out after ${timeout / 1000}s`));
          } else {
            reject(new Error(stderr || err.message));
          }
          return;
        }
        resolve(stripAnsi(stdout).trim());
      }
    );
  });
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

// --- Server ---

const server = new McpServer({
  name: "cursor-cli-mcp",
  version: "1.0.0",
});

// Tool: Review code
server.tool(
  "cursor_review",
  "Review code using any model available in your Cursor subscription. Checks for bugs, security issues, performance, and quality.",
  {
    code: z.string().describe("Code content to review"),
    context: z.string().optional().describe("Additional context (what the code does, what to focus on)"),
    model: z.string().optional().describe("Model to use (e.g. gpt-5.4-high, sonnet-4.6-thinking, auto). Defaults to auto."),
    timeout: z.number().optional().describe("Timeout in seconds. Defaults to 120."),
  },
  async ({ code, context, model, timeout }) => {
    const timeoutMs = (timeout || DEFAULT_TIMEOUT_S) * 1000;
    let prompt = DEFAULT_REVIEW_PROMPT;
    if (context) prompt += `\n\nContext: ${context}`;
    prompt += `\n\n---\n\n${code}`;

    try {
      const result = await runAgent(prompt, { model: model || "auto", timeout: timeoutMs });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// Tool: Review file
server.tool(
  "cursor_review_file",
  "Review a file using any model available in your Cursor subscription.",
  {
    file_path: z.string().describe("Absolute path to the file to review"),
    context: z.string().optional().describe("Additional context or focus areas for the review"),
    model: z.string().optional().describe("Model to use. Defaults to auto."),
    timeout: z.number().optional().describe("Timeout in seconds. Defaults to 120."),
  },
  async ({ file_path, context, model, timeout }) => {
    const timeoutMs = (timeout || DEFAULT_TIMEOUT_S) * 1000;
    const absPath = resolve(file_path);

    let fileContent;
    try {
      fileContent = await readFile(absPath, "utf-8");
    } catch {
      return fail(new Error(`Could not read file ${absPath}`));
    }

    let prompt = DEFAULT_REVIEW_PROMPT;
    if (context) prompt += `\n\nContext: ${context}`;
    prompt += `\n\nFile: ${absPath}\n\n---\n\n${fileContent}`;

    try {
      const result = await runAgent(prompt, { model: model || "auto", timeout: timeoutMs });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// Tool: General prompt
server.tool(
  "cursor_prompt",
  "Send any prompt to Cursor and get a response from any model in your subscription. No API key needed.",
  {
    prompt: z.string().describe("The prompt to send"),
    model: z.string().optional().describe("Model to use. Defaults to auto."),
    mode: z.enum(["ask", "plan"]).optional().describe("Agent mode: ask (read-only Q&A) or plan (planning). Defaults to ask."),
    timeout: z.number().optional().describe("Timeout in seconds. Defaults to 120."),
  },
  async ({ prompt, model, mode, timeout }) => {
    const timeoutMs = (timeout || DEFAULT_TIMEOUT_S) * 1000;

    try {
      const result = await runAgent(prompt, {
        model: model || "auto",
        mode: mode || "ask",
        timeout: timeoutMs,
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// Tool: List models
server.tool(
  "cursor_list_models",
  "List all models available in your Cursor subscription.",
  {},
  async () => {
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(
          AGENT_PATH,
          ["--list-models"],
          { timeout: 15000, env: { ...process.env } },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(stderr || err.message));
              return;
            }
            resolve(stripAnsi(stdout).trim());
          }
        );
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
