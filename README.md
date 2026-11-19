# Sani

Sani is a small self-hosted broker that sits between AI coding agents and the
authenticated MCP servers they want to use. The agent never holds a platform
credential. It asks Sani for an action, a person approves that exact call in a
browser, and Sani makes the call with the credential it keeps on its own
server. The agent gets back a screened result.

It works with any client that speaks MCP over HTTP, including Claude Code and
Codex.

## Contents

- [Why Sani exists](#why-sani-exists)
- [How it works](#how-it-works)
- [What the agent sees](#what-the-agent-sees)
- [Request states](#request-states)
- [Run Sani](#run-sani)
- [Settings](#settings)
- [Connect a platform](#connect-a-platform)
- [Connect an agent](#connect-an-agent)
- [Security boundary](#security-boundary)
- [Limits](#limits)
- [Project layout](#project-layout)
- [Verify](#verify)
- [Status](#status)
- [Licence](#licence)

## Why Sani exists

Giving an agent a GitHub or Linear token means the token lives in its shell,
its config files and its context, and every tool call it makes is one you did
not see. Sani changes three things:

- **The credential stays out of reach.** Tokens and OAuth state are encrypted
  in Sani's database, on a host the agent cannot read. The agent holds only a
  Sani agent key, which can request actions but cannot approve them.
- **A person approves each call.** Every request shows the connection, the
  tool and the exact arguments. Nothing is sent until you approve it, and an
  approval is spent on one dispatch.
- **Only the tools you enable exist.** Sani lists a platform's tools and you
  switch on the ones you want. If the platform later changes a tool's
  definition, Sani switches it off until you review it again.

## How it works

```
 agent (Claude Code, Codex)          you (browser)           platform MCP server
        |                                 |                          |
        |-- request_action -------------->|                          |
        |<- approval link, request id ----|                          |
        |                                 |-- review and approve     |
        |                          Sani --|------- tools/call ------>|
        |                          Sani <-|------- result -----------|
        |-- get_request ----------------->|                          |
        |<- screened result --------------|                          |
```

1. You add a **connection**: a name, the platform's Streamable HTTP MCP
   endpoint, and either a bearer token or an OAuth issuer.
2. Sani discovers the platform's tools. You enable the ones agents may request.
3. You create an **agent key** for each client. It is shown once and stored
   only as a hash.
4. The agent calls `request_action`. Sani checks the arguments against the
   tool's JSON Schema, stores the request and returns an approval link.
5. You open the link, sign in, and approve or decline.
6. On approval Sani re-reads the tool from the platform, confirms it still
   matches what you enabled, and sends the call once with the stored
   credential.
7. Sani screens the reply for stored credentials and keeps the text and
   structured data. The agent fetches it with `get_request`.

## What the agent sees

Sani is itself an MCP server at `<SANI_ORIGIN>/mcp`. It exposes three tools:

| Tool | Purpose |
| --- | --- |
| `list_actions` | List the enabled actions and their argument schemas |
| `request_action` | Ask for one action; returns a request ID and an approval link |
| `get_request` | Read the status, and the result once there is one, of the agent's own request |

An agent can read only the requests it made. Errors returned to the agent are
fixed sentences, because platform and storage errors can carry credentials or
submitted arguments.

## Request states

| State | Meaning |
| --- | --- |
| `pending` | Waiting for your decision |
| `expired` | Nobody decided within 15 minutes |
| `declined` | You declined it, or the arguments contained a stored credential |
| `running` | Approved and being sent |
| `succeeded` | The platform answered and the result passed screening |
| `failed` | The call was not sent, the platform reported an error, or the result was withheld |
| `unknown` | The call was sent and Sani cannot confirm the outcome, for example after a timeout or a restart |

Every state after `pending` is final. A retry is a new request and needs a new
approval.

## Run Sani

Use Node.js 24.13 or newer. Sani runs its TypeScript sources directly, so
there is no build step. For local testing, generate a new operator password
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

## Settings

| Setting | Purpose |
| --- | --- |
| `SANI_ADMIN_PASSWORD` | Browser sign-in password, at least 16 characters |
| `SANI_ENCRYPTION_KEY` | 32 random bytes encoded as base64url |
| `SANI_ORIGIN` | Browser origin used for approval links, session cookies and the OAuth callback. HTTPS, or HTTP on loopback. Default `http://127.0.0.1:8765` |
| `SANI_HOST`, `SANI_PORT` | Listener address and port, default `127.0.0.1` and `8765` |
| `SANI_DB` | SQLite path, default `data/sani.sqlite` |

## Connect a platform

1. Add a named connection to the platform's Streamable HTTP MCP endpoint.
   Give Sani a restricted bearer token or choose OAuth and enter the
   platform's trusted issuer. For OAuth, complete the provider sign-in in
   your browser. Sani pins discovery to that issuer. For a pre-registered
   OAuth client, enter its client ID and secret in **OAuth settings**, and
   use the callback URL shown there when registering the app.
2. Refresh the tool list as needed and enable the exact tools you want.
   Sani disables a changed tool after refresh so you can review it.
3. Create an agent access key for each client. Sani shows it once. Put it in
   that client's private MCP configuration. The agent key can request actions
   and retrieve its own results. Browser sign-in is required to approve.

Suggested first connections:

- **GitHub.** Use `https://api.githubcopilot.com/mcp/x/pull_requests/readonly`
  and a [GitHub App registered for OAuth](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md).
  Give the app **Pull requests: Read-only** permission and install it on
  the test repository. Choose OAuth, enter `https://github.com/login/oauth`
  as the issuer, and supply the app's client ID, client secret, and
  `offline_access` scope. A repository-scoped bearer token is also supported.
- **Linear.** Use the [read-only Linear MCP server](https://linear.app/docs/mcp)
  at `https://mcp.linear.app/mcp/readonly`. Choose OAuth and enter
  `https://mcp.linear.app` as the issuer. Enable an issue lookup and read a test issue.

## Connect an agent

Connect the client to `<SANI_ORIGIN>/mcp` with its own Sani agent key in the
HTTP Authorization header (`Authorization: Bearer sani_...`). Use the client's
[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp) or
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Copy `skills/use-sani` into a skills directory for
[Claude Code](https://code.claude.com/docs/en/skills) or
[Codex](https://learn.chatgpt.com/docs/build-skills). The skill tells the
agent to request actions through Sani, hand you the approval link, wait, and
keep credentials out of chat and tool arguments.

Ask the client to use an enabled action. Open the Sani approval link to
review the connection, tool, and exact arguments. Approving dispatches the
request once. The agent fetches the result using the original agent key.

## Security boundary

**Credentials at rest.** Bearer tokens, OAuth tokens and OAuth client secrets
are encrypted with AES-256-GCM under `SANI_ENCRYPTION_KEY`, bound to the
connection's ID, revision and URL. Agent keys and OAuth state values are
stored as SHA-256 hashes. Request arguments and results are stored as plain
JSON in the database, so protect the database file like the data it holds.

**Outbound calls.** Sani talks to platforms over public HTTPS only. It refuses
redirects and private, loopback and link-local addresses, checks the resolved
address at connection time, pins OAuth discovery to the issuer you entered,
and uses PKCE. Responses are capped at 1 MiB and calls time out after 15
seconds.

**Screening.** Tool definitions, request arguments and results are checked for
every stored credential, as plain text, URL-encoded, base64 and base64url.
Matching data is withheld. Results are limited to text and structured data up
to 64 KiB. The screening guarantee covers the stored credentials and the
encodings checked by the test suite; it is not a general secret scanner.

**Approval.** Only a signed-in operator can approve. The session cookie is
HttpOnly and SameSite, lasts 8 hours, and is invalidated by changing the
operator password or the encryption key. A request is bound to the tool
definition and connection revision it was made against, so changing a
credential or a tool invalidates the requests waiting on it.

**Still your job.** Treat external tool descriptions and results as untrusted
data. There is one operator account and no built-in sign-in throttling, so put
Sani behind a reverse proxy that rate-limits and serves HTTPS. Sani has not
had an independent security audit.

Rotate or remove a platform credential to invalidate earlier approvals for
that connection. Revoke a Sani agent key to stop that client. Revoke the
platform token at the provider if you need to end its use outside Sani.

## Limits

| Limit | Value |
| --- | --- |
| Time to approve a request | 15 minutes |
| Pending requests per agent | 25 |
| Agent request body | 64 KiB |
| Screened arguments or result | 64 KiB |
| Platform response | 1 MiB |
| Platform call timeout | 15 seconds |
| Processes per database | 1 |

## Project layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Reads the environment and starts the HTTP server |
| `src/app.ts` | Connections, approvals and the request lifecycle |
| `src/mcp.ts` | The MCP endpoint agents connect to |
| `src/web.ts` | The operator pages: sign-in, connections, agent keys, approvals |
| `src/remote.ts` | Outbound MCP and OAuth client with the network rules |
| `src/store.ts` | SQLite storage and encryption of stored credentials |
| `src/guard.ts` | Encryption, fingerprints, credential screening and input checks |
| `skills/use-sani` | The agent skill |
| `test/` | Tests against local MCP and OAuth fixtures |

Runtime dependencies are the MCP SDK, Ajv, ipaddr.js, undici and Zod. Storage
is Node's built-in SQLite.

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

## Status

Sani is a release candidate (`1.0.0-rc.3`). The interface may still change
before 1.0. Start with read-only tools and restricted test credentials.

## Licence

MIT. See [LICENSE](LICENSE).
