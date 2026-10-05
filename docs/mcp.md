# The MCP server

The MCP server makes the compiler available to anything that speaks the [Model
Context Protocol](https://modelcontextprotocol.io). MCP is an open standard,
so it doesn't matter which model or vendor sits behind the agent. Coding
agents, IDE assistants and desktop chat apps all use it. The agent asks for
context itself when it needs it, so nobody has to remember to paste it in.

A typical exchange goes like this. The agent calls `get_context` with the task
and gets back a package. Some items in it are only titles and ids, because the
budget was tight. If any of those matter for what it's about to do, it calls
`get_units` with their ids and reads them in full. The first package stays
small, and nothing is out of reach.

## Tools

`get_context` compiles the package for a task. The only required argument is
`task`. It also accepts `activity`, `service`, `domain`, `team`, `repo`,
`environment`, `budget` and `format` (XML by default, or Markdown or JSON).
Any gaps are added at the end in a `<context_gaps>` block. If you pass a
service, domain or team that doesn't exist, you get an error listing the ones
that do.

`get_units` returns the full text of up to 50 units by id, along with their
scope, links, owner, source and review date.

`search_units` is a plain keyword search over every unit, ignoring scope. You
can narrow it by layer or kind and limit the number of results.

`explain_context` shows why each unit was or wasn't picked for a task. It's
useful when someone asks why the agent didn't consider something.

`list_topology` lists the services with their domain, team and repo, plus the
environments and activities. That way the agent can pass valid names to
`get_context`.

`validate_knowledge_base` reports broken YAML and links that point nowhere.

None of the tools change anything. The server only reads the knowledge base.

Every unit can also be read as a resource at `context://unit/<id>`, with id
completion. The `with-org-context` prompt takes a task, plus an optional
service and activity, and starts a conversation with the package already
included. Clients that support MCP prompts usually show it as a slash command
or in a prompt menu.

When a client connects, the server sends a short set of instructions. They tell
the agent to call `get_context` before planning or changing anything, to treat
must-level items as hard constraints, and to use `get_units` for anything that
was abbreviated.

## Picking up edits

Before handling each request, the server checks the modification time and size
of every YAML file in the packs it loaded, including packs pulled in with
`extends`. If anything changed or a file was added or removed, it reloads.
Someone can fix a rule and the next request will see it, without restarting
the agent.

## Setting it up

Build the server once:

```bash
npm install && npm run build
```

The server is a normal stdio MCP server, started with
`node packages/mcp-server/dist/main.js --kb <knowledge base folder>`. Every client needs the
same two things: the command `node`, and those arguments. Only the place you
put them differs. Use absolute paths, because each client starts the server
from its own working directory.

Most clients use this JSON shape:

```json
{
  "mcpServers": {
    "org-context": {
      "command": "node",
      "args": ["/path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js", "--kb", "/path/to/your-org-context"]
    }
  }
}
```

Where that block goes:

- Cursor: `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Gemini CLI: `~/.gemini/settings.json`
- Claude Desktop: `claude_desktop_config.json`
- Any project-level `.mcp.json`, for clients that read one. This repo ships one
  that runs the server from source against `knowledge/monty-python-co`.

VS Code uses a slightly different file, `.vscode/mcp.json`, with `servers`
instead of `mcpServers`:

```json
{
  "servers": {
    "org-context": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js", "--kb", "/path/to/your-org-context"]
    }
  }
}
```

Codex keeps its servers in `~/.codex/config.toml`:

```toml
[mcp_servers.org-context]
command = "node"
args = ["/path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js", "--kb", "/path/to/your-org-context"]
```

Some command-line agents can also register a server with one command. For
example, Codex:

```bash
codex mcp add org-context -- node /path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js --kb /path/to/your-org-context
```

And Claude Code:

```bash
claude mcp add org-context -- node /path/to/context-engineering-sdlc/packages/mcp-server/dist/main.js --kb /path/to/your-org-context
```

These file locations and commands come from each tool's own documentation, and
they do change between versions. If one doesn't work, check the client's MCP
docs. The server side is the same everywhere.

### Without MCP

If your tool doesn't support MCP, or you're using a plain chat window, run the
CLI and paste its output ahead of your request:

```bash
npm run ctx -- build "your task here" --format xml
```

You lose the ability to fetch abbreviated units on demand, so give it a larger
`--budget` to get more of them in full.

The server looks for the knowledge base in this order: the `--kb` argument,
then the `CTX_KB` environment variable, then the current folder if it has a
`context.yaml`. When it runs from a checkout of this repo, it falls back to the
sample in `knowledge/monty-python-co`.

## How an agent should use it

Call `get_context` with the user's task in their own words. Pass `service` if
the user named one, and otherwise let the server work it out. Read the
`<context_gaps>` block. If it says the task couldn't be placed, call
`list_topology` and try again with a service. Expand any abbreviated items that
affect the plan. Treat must-level items as constraints, and if the request
conflicts with one, say so instead of going along with it. When writing plans
or pull request descriptions, mention the ids of the rules that shaped them,
so reviewers can see where a decision came from.

## Tests

`packages/mcp-server/test/mcp.test.ts` connects a real MCP client to the server over an in-memory
transport. It covers every tool, the unit resources, the prompt, input
validation and hot reload.
