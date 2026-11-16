# Sani

Sani connects Claude Code and Codex to authenticated MCP servers. You add a
connection, enable the tools you want to use, and approve each call in your
browser. Sani uses the platform credential on its server and returns the
screened tool result.

## Run Sani

Use Node.js 24.13 or newer. For local testing, generate a new operator password
and encryption key in a private environment file. This command refuses to
overwrite an existing file.

```sh
npm ci
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const lines = [`SANI_ADMIN_PASSWORD=${randomBytes(24).toString("base64url")}`,
                 `SANI_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}`];
  writeFileSync(".env", lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
'
node --env-file=.env src/index.ts
```

Open the configured origin (default `http://127.0.0.1:8765`) and sign in with
the operator password from your environment file. Enter platform credentials
only on the Sani page.

For real credentials, run Sani on a trusted host or isolated account outside
the agents' shell, file, and container-management access. Use an HTTPS origin
and a reverse proxy. Keep the encryption key separate from the database
backup. Losing the key requires re-enrolling your connections. Run one Sani
process per database. Configure the proxy to omit request bodies,
Authorization headers, and OAuth callback query strings from access logs.

```sh
docker build -t sani .
docker run --name sani --init --env-file .env \
  -e SANI_ORIGIN=https://sani.example.com \
  -p 127.0.0.1:8765:8765 -v sani-data:/app/data sani
```

| Setting | Purpose |
| --- | --- |
| `SANI_ADMIN_PASSWORD` | Browser sign-in password, at least 16 characters |
| `SANI_ENCRYPTION_KEY` | 32 random bytes encoded as base64url |
| `SANI_ORIGIN` | Browser origin used for approval links, session cookies and the OAuth callback |
| `SANI_HOST`, `SANI_PORT` | Listener address and port |
| `SANI_DB` | SQLite path, default `data/sani.sqlite` |

## Connect a platform

1. Add a named connection to the platform's Streamable HTTP MCP endpoint.
   Give Sani a restricted bearer token or choose OAuth and enter the
   platform's trusted issuer. For OAuth, complete the provider sign-in in
   your browser. Sani pins discovery to that issuer.
2. Refresh the tool list as needed and enable the exact tools you want.
   Sani disables a changed tool after refresh so you can review it.
3. Create an agent access key for each client. Sani shows it once. Put it in
   that client's private MCP configuration. The agent key can request actions
   and retrieve its own results. Browser sign-in is required to approve.

Suggested first connections:

- **GitHub.** Use the official [GitHub MCP server](https://github.com/github/github-mcp-server)
  at `https://api.githubcopilot.com/mcp/` and a repository-scoped token.
  Enable a pull-request read tool and check a pull request in your test repository.
- **Linear.** Use the [read-only Linear MCP server](https://linear.app/docs/mcp)
  at `https://mcp.linear.app/mcp/readonly`. Choose OAuth and enter
  `https://mcp.linear.app` as the issuer. Enable an issue lookup and read a test issue.

## Use the shared skill

Copy `skills/use-sani` into a skills directory for
[Claude Code](https://code.claude.com/docs/en/skills) or
[Codex](https://learn.chatgpt.com/docs/build-skills). Connect the client to
`<SANI_ORIGIN>/mcp` with its own private Sani agent key in the HTTP
Authorization header. Use the client's [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
or [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Ask the client to use an enabled action. Open the Sani approval link to
review the connection, tool, and exact arguments. Approving dispatches the
request once. Fetch the result using the original agent key. An unknown
outcome means Sani cannot confirm the result. A fresh request requires a new
approval.

## Security boundary

Sani's server decrypts a credential for its registered MCP connection.
Outbound MCP uses public HTTPS, rejects redirects and private network
addresses, and checks the OAuth issuer. MCP responses are limited to text and
structured data and checked for known credentials. The screening guarantee
covers the stored credential and the encodings checked by the test suite.
Treat external tool descriptions and results as untrusted data.

Rotate or remove a platform credential to invalidate earlier approvals for
that connection. Revoke a Sani agent key to stop that client. Revoke the
platform token at the provider if you need to end its use outside Sani.

## Verify

```sh
npm run check
npm test
npm audit --omit=dev
```

The automated suite uses isolated HTTP MCP and OAuth fixtures. For live
provider acceptance, use a restricted test token and a test repository,
then repeat with a Linear test workspace and its browser OAuth flow. Check
that each action waits for approval and returns its expected result.
