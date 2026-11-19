# Sani

[![CI](https://github.com/sianachi/sani/actions/workflows/ci.yml/badge.svg)](https://github.com/sianachi/sani/actions/workflows/ci.yml)

Sani is a small self-hosted broker that sits between AI coding agents and the
credentials they need. The agent never holds a token. It asks Sani to do
something, a person approves that exact request in a browser, and Sani does it
with the credential it keeps on its own server. The agent gets back a screened
result.

You can use it two ways, together or separately:

- **MCP tool calls.** Connect an authenticated MCP server such as GitHub or
  Linear. The agent requests one of the tools you enabled and Sani makes the
  call with the stored token or OAuth sign-in.
- **Shell commands.** Store a secret such as `GH_TOKEN`. The agent requests a
  command, for example `gh pr list --repo acme/site`, and Sani runs it in a
  throwaway Docker container with only the secrets that command named. This
  covers CLIs and plain HTTP APIs that have no MCP server. See
  [Run commands in the sandbox](#run-commands-in-the-sandbox).

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
- [Run commands in the sandbox](#run-commands-in-the-sandbox)
- [Connect an agent](#connect-an-agent)
- [Security boundary](#security-boundary)
- [Limits](#limits)
- [Project layout](#project-layout)
- [Verify](#verify)
- [Releases](#releases)
- [Status and known limits](#status-and-known-limits)
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
- **Commands run away from the agent.** A command that needs a secret runs in
  a locked-down container on Sani's host, so the secret never reaches the
  agent's shell, files or context.
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

A shell command follows the same path: the agent calls `request_command`, you
approve the exact command line, and Sani runs it once in the sandbox and
returns the exit code and screened output.

## What the agent sees

Sani is itself an MCP server at `<SANI_ORIGIN>/mcp`. It exposes these tools:

| Tool | Purpose |
| --- | --- |
| `list_actions` | List the enabled actions and their argument schemas, and the sandbox's secret names |
| `request_action` | Ask for one action; returns a request ID and an approval link |
| `request_command` | Ask to run one shell command in the sandbox; present only when the sandbox is on |
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

Pick one. Each prints a sign-in address and, on the first run, your operator
password. There is nothing to configure first.

**With Node.js** (24.13 or newer), nothing to clone:

```sh
npx github:sianachi/sani
```

**With Docker:**

```sh
docker run --init -p 127.0.0.1:8765:8765 -v sani-data:/app/data ghcr.io/sianachi/sani
```

The image is public and built for `linux/amd64` and `linux/arm64`. Pin a
version with a tag such as `ghcr.io/sianachi/sani:v1.0.0-rc.5`.

**From source:**

```sh
git clone https://github.com/sianachi/sani.git
cd sani
npm ci
npm start
```

Then open `http://127.0.0.1:8765`, sign in, and follow **Get started** on the
page:

1. Add a connection (the form has one-click starting points for Linear and
   GitHub) or save a secret for sandbox commands.
2. Create an agent token. Sani shows the exact command that connects Claude
   Code, the settings for Codex, and the URL and header for any other MCP
   client.
3. Ask your agent to use Sani and approve its requests. Sani tells a
   connected agent how to use it, so there is nothing else to install.

On the first run Sani creates the operator password and an encryption key and
saves them with its database in `~/.sani` (the `sani-data` volume under
Docker). If you forget the password, it is in `~/.sani/sani.env`; under Docker
it is in the first lines of `docker logs`.

To let agents run commands, build the sandbox image once and restart Sani.
This needs Docker, and Sani itself running outside Docker:

```sh
npx github:sianachi/sani sandbox
```

### For real credentials

The first-run setup keeps the encryption key beside the database, which is
convenient and fine for trying Sani out. Before you store credentials that
matter:

- Set `SANI_ADMIN_PASSWORD` and `SANI_ENCRYPTION_KEY` yourself, for example
  in the environment or an env file, and keep the key separate from the
  database backup. Losing the key requires re-enrolling your connections.
- Run Sani on a trusted host or isolated account outside the agents' shell,
  file, and container-management access.
- Set `SANI_ORIGIN` to an HTTPS origin behind a reverse proxy. Configure the
  proxy to omit request bodies, Authorization headers, and OAuth callback
  query strings from access logs.
- Run one Sani process per database.

## Settings

| Setting | Purpose |
| --- | --- |
| `SANI_ADMIN_PASSWORD` | Browser sign-in password, at least 16 characters. Created on first run if neither this nor the key is set |
| `SANI_ENCRYPTION_KEY` | 32 random bytes encoded as base64url. Created on first run likewise |
| `SANI_ORIGIN` | Browser origin used for approval links, session cookies and the OAuth callback. HTTPS, or HTTP on loopback. Default `http://127.0.0.1:8765` |
| `SANI_HOST`, `SANI_PORT` | Listener address and port, default `127.0.0.1` and `8765` |
| `SANI_DB` | SQLite path, default `~/.sani/sani.sqlite` (`/app/data/sani.sqlite` in the Docker image) |
| `SANI_SANDBOX_IMAGE` | Docker image for sandbox commands. Unset means Sani uses the `sani-sandbox` image if you built it, and otherwise the sandbox is off |

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

## Run commands in the sandbox

Some platforms have a CLI and no MCP server. For those, an agent can ask Sani
to run a shell command with a stored secret in its environment.

1. Run `npx github:sianachi/sani sandbox` (or `npm run sandbox:build` in a
   clone). It builds the `sani-sandbox` image, which holds `curl`, `jq`, `git`
   and `gh`. To add tools, edit `sandbox/Dockerfile` in a clone and rebuild.
   If you add the `gh` CLI's token as a secret, name it `GH_TOKEN`.
2. Restart Sani. It uses that image when it exists. To use a different image,
   set `SANI_SANDBOX_IMAGE`; Sani never pulls an image for you. The host needs
   the `docker` CLI and access to a Docker daemon.
3. In the console, add **Sandbox secrets**. The name is the environment
   variable the command sees, for example `GH_TOKEN`.
4. The agent calls `request_command` with a command and the secret names it
   needs. You see the exact command and the names, and approve or decline.
5. Sani runs `sh -c <command>` in a new container and returns the exit code
   and the combined output.

Each run gets a fresh container that is removed afterwards. It runs as an
unprivileged user with all capabilities dropped, a read-only filesystem apart
from a 64 MiB `/tmp`, no host mounts, 512 MiB of memory, one CPU and a 60
second limit. It receives only the secrets the request named. Commands run one
at a time.

Replacing or removing a secret invalidates the requests waiting on it. A
command that fails to start is `failed`; one that times out is `unknown`,
because it may have acted before it was stopped. A non-zero exit code is a
`succeeded` request with that exit code in the result.

The official Sani image does not contain Docker. To use the sandbox, run Sani
directly on the host, or give its container a Docker CLI and daemon access,
which is equivalent to root on that host.

## Connect an agent

Creating an agent token shows a ready-to-run command for Claude Code:

```sh
claude mcp add --transport http sani <SANI_ORIGIN>/mcp --header "Authorization: Bearer sani_..."
```

For any other client, connect it to `<SANI_ORIGIN>/mcp` with its own Sani agent key in the
HTTP Authorization header (`Authorization: Bearer sani_...`). Use the client's
[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp) or
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For Codex, the token page shows the `~/.codex/config.toml` entry to paste.

Sani sends its usage instructions to every connected client, telling the
agent to request actions through Sani, hand you the approval link, wait, and
keep credentials out of chat and tool arguments. If your client ignores
server instructions, copy `skills/use-sani` into its skills directory for
[Claude Code](https://code.claude.com/docs/en/skills) or
[Codex](https://learn.chatgpt.com/docs/build-skills).

Ask the client to use an enabled action. Open the Sani approval link to
review the connection, tool, and exact arguments. Approving dispatches the
request once. The agent fetches the result using the original agent key.

## Security boundary

**Credentials at rest.** Bearer tokens, OAuth tokens, OAuth client secrets and
sandbox secrets are encrypted with AES-256-GCM under `SANI_ENCRYPTION_KEY`, bound to the
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

**Sandbox commands.** The container isolates the command from the Sani host,
its database and its key. It does not isolate the secret from the command: a
command holding `GH_TOKEN` can send it to any host the container can reach,
or print it in a form screening does not recognise. The container has normal
outbound network access, including to private addresses reachable from the
host. Your review of the exact command is the control, so decline anything
you do not fully understand, and give each secret the narrowest scope the
provider allows.

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
| Sandbox command length | 4096 characters |
| Sandbox command time | 60 seconds |
| Sandbox output returned | 16 KiB |
| Secrets per command | 16 |
| Processes per database | 1 |

## Project layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Reads the environment and starts the HTTP server |
| `src/app.ts` | Connections, approvals and the request lifecycle |
| `src/mcp.ts` | The MCP endpoint agents connect to |
| `src/web.ts` | The operator pages: sign-in, connections, agent keys, approvals |
| `src/remote.ts` | Outbound MCP and OAuth client with the network rules |
| `src/index.ts sandbox` | The `sani-mcp sandbox` subcommand that builds the sandbox image |
| `src/sandbox.ts` | Runs approved commands in Docker |
| `src/setup.ts` | First-run password and key, and sandbox image detection |
| `src/render.ts` | Result tables and the command view |
| `sandbox/Dockerfile` | The default sandbox image |
| `src/store.ts` | SQLite storage and encryption of stored credentials |
| `src/guard.ts` | Encryption, fingerprints, credential screening and input checks |
| `skills/use-sani` | The agent skill |
| `test/` | Tests against local MCP and OAuth fixtures |
| `.github/workflows/` | CI on every push, and the release that publishes the image |

Runtime dependencies are the MCP SDK, Ajv, ipaddr.js, undici and Zod. Storage
is Node's built-in SQLite. The sandbox uses the `docker` CLI on the host.

From a clone Sani runs its TypeScript sources directly. The installed command
(`sani-mcp`) runs a compiled copy in `dist/`, built by `npm run build`, because
Node does not run TypeScript from inside `node_modules`.

## Verify

```sh
npm run check
npm test
npm audit --omit=dev
```

The automated suite uses isolated HTTP MCP and OAuth fixtures. For live
provider acceptance, use a restricted test token and a test repository,
then repeat with a Linear test workspace and its browser OAuth flow. Check
that each action waits for approval and returns its expected result. The
Docker sandbox test runs only when Docker and the `alpine:3` image are present.

CI runs the same three commands on every push and pull request, with the
Docker sandbox test included.

## Releases

Pushing a tag `vX.Y.Z` that matches the version in `package.json` runs the
release workflow. It runs the tests, publishes the multi-arch image to
`ghcr.io/sianachi/sani` under that tag and `latest`, and creates the GitHub
release. A tag with a hyphen, such as `v1.0.0-rc.5`, is marked as a
pre-release.

The same workflow publishes `sani-mcp` to npm once the repository has an
`NPM_TOKEN` secret. Until then that step is skipped, and the way to run Sani
without cloning is `npx github:sianachi/sani`.

## Status and known limits

Sani is a release candidate (`1.0.0-rc.5`). The interface may still change
before 1.0. Start with read-only tools and restricted test credentials.

What works today, each checked against the published code:

- `npx github:sianachi/sani` and the Docker image both start with no
  configuration and print a first-run password.
- MCP tool calls with bearer tokens and OAuth, and sandbox commands with
  stored secrets, each behind one approval.
- Copy-ready agent setup for Claude Code, Codex and other MCP clients.

Known limits:

- **Not on npm yet.** `npx sani-mcp` does not work until the package is
  published; use the GitHub form above.
- **No sandbox when Sani runs in Docker.** The image has no Docker client.
  Run Sani on the host to use sandbox commands.
- **First-run setup trades safety for ease.** It stores the encryption key
  beside the database. See [For real credentials](#for-real-credentials).
- **The sandbox does not contain the secret.** An approved command can send
  its secrets anywhere the container can reach. See
  [Security boundary](#security-boundary).
- **The client setup snippets are unverified against live clients.** The
  Claude Code command and the Codex settings follow each client's
  documentation. The MCP endpoint itself is covered by the tests.
- **Tested on macOS and Linux.** Linux is covered by CI. Windows has not been
  tried.
- **One operator, no sign-in throttling.** Put a rate-limiting reverse proxy
  in front of a Sani that others can reach.
- **No independent security audit.**

## Licence

MIT. See [LICENSE](LICENSE).
