import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

async function connect(kbDir: string): Promise<Client> {
  const { server } = createServer(kbDir);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  (await c.callTool({ name, arguments: args })) as unknown as ToolResult;
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("MCP server", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("knowledge/monty-python-co");
  });
  afterAll(async () => {
    await client.close();
  });

  it("advertises tools, with instructions telling the agent when to call them", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["explain_context", "get_context", "get_units", "list_topology", "search_units", "validate_knowledge_base"].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(client.getInstructions()).toContain("call get_context");
  });

  it("get_context returns an XML package with inferred scope", async () => {
    const r = await call(client, "get_context", { task: "Add a new payment provider to the payment service", budget: 1500 });
    const t = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(t).toContain('<organizational_context activity="implementation"');
    expect(t).toContain("service=payment-service");
    expect(t).toContain('id="dom.payments.provider-abstraction"');
  });

  it("get_context rejects unknown services with the valid options", async () => {
    const r = await call(client, "get_context", { task: "anything", service: "nope-service" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("payment-service");
  });

  it("get_context validates the activity enum", async () => {
    const r = await call(client, "get_context", { task: "x", activity: "dancing" });
    expect(r.isError).toBe(true);
  });

  it("get_units expands references, and reports missing ids", async () => {
    const r = await call(client, "get_units", { ids: ["dom.payments.decline-reasons", "dom.payments.provider-abstraction", "does.not.exist"] });
    const t = textOf(r);
    expect(t).toContain("hard declines");
    expect(t).toContain("- dependsOn: `dom.payments.transaction-lifecycle`");
    expect(t).toContain("Not found: does.not.exist");
  });

  it("search_units finds units across scopes and honours filters", async () => {
    const t = textOf(await call(client, "search_units", { query: "reconciliation settlement" }));
    expect(t.split("\n")[0]).toContain("dom.ledger.reconciliation");
    const ops = textOf(await call(client, "search_units", { query: "provider", layer: "operations" }));
    expect(ops).not.toMatch(/\[(business|domain|architecture|code)\//);
  });

  it("explain_context, list_topology and validate_knowledge_base respond", async () => {
    expect(textOf(await call(client, "explain_context", { task: "Roll out the Klarna adapter to production", service: "provider-gateway" }))).toContain(
      "Activity:  deployment",
    );
    expect(textOf(await call(client, "list_topology"))).toContain("| provider-gateway | payments |");
    expect(textOf(await call(client, "validate_knowledge_base"))).toContain("no problems");
  });

  it("serves units as resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === "context://unit/dom.payments.money")).toBe(true);
    const res = await client.readResource({ uri: "context://unit/dom.payments.money" });
    expect((res.contents[0] as { text: string }).text).toContain("Floating point is forbidden");
  });

  it("offers a prompt that embeds the compiled context", async () => {
    const p = await client.getPrompt({ name: "with-org-context", arguments: { task: "Add refunds to the Klarna adapter", service: "provider-gateway" } });
    const t = (p.messages[0]!.content as { text: string }).text;
    expect(t).toContain("<organizational_context");
    expect(t).toContain("Add refunds to the Klarna adapter");
  });
});

describe("MCP hot reload", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-mcp-"));
    cpSync("packages/cli/templates/org", dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("picks up edited and new unit files without restarting", async () => {
    const client = await connect(dir);
    const before = textOf(await call(client, "search_units", { query: "zebra" }));
    expect(before).toContain("No units match");

    writeFileSync(
      join(dir, "domain", "zebra.yaml"),
      "units:\n  - id: dom.zebra\n    layer: domain\n    kind: domain-rule\n    title: Zebra striping rule\n    body: Zebras have stripes.\n",
    );
    const after = textOf(await call(client, "search_units", { query: "zebra" }));
    expect(after).toContain("dom.zebra");

    const f = join(dir, "domain", "zebra.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("Zebra striping rule", "Zebra pattern rule (edited)"));
    expect(textOf(await call(client, "get_units", { ids: ["dom.zebra"] }))).toContain("edited");
    await client.close();
  });
});
