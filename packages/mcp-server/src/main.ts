import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findKnowledgeBase } from "@context-sdlc/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdio MCP server. stdout carries the protocol, so diagnostics go to stderr only.
const { values } = parseArgs({ options: { kb: { type: "string", short: "k" } } });
/** The sample knowledge base, used when running from a checkout of this repo. */
const SAMPLE_KB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "knowledge", "monty-python-co");

try {
  const kbDir = findKnowledgeBase(values.kb, SAMPLE_KB);
  const { server, handle } = createServer(kbDir);
  await server.connect(new StdioServerTransport());
  const kb = handle.get();
  process.stderr.write(`context-engineering-sdlc MCP: ${kb.manifest.organization} (${kb.units.size} units) from ${kbDir}\n`);
} catch (e) {
  process.stderr.write(`context-engineering-sdlc MCP failed to start: ${(e as Error).message}\n`);
  process.exit(1);
}
