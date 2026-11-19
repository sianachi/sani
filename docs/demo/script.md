# Demo script

A script for showing Sani's demo mode live. About two minutes, plus a 15-second opening and a 30-second fallback.

The recording in [demo.mp4](demo.mp4) and the screenshots beside it were made from a checkout of an earlier build, `1.0.0-rc.4`, with `node src/index.ts`. The flow is the same: sign in, the built-in demo connection, `lookup_ticket` for ticket `1001`, approval, and the screened result. The first-run log lines, the console and the agent token page have changed since, so they look different from what this script describes. The agent in the recording is named `editor`.

## Before you start

Use a machine with the repo, or a machine that can pull the image. Node on a checkout must be 24.13 or newer. Open the UI at `http://127.0.0.1:8765`. `localhost` is a different site to the browser, so the sign-in cookie will not match an approval link on the other host.

Have two terminals. One runs Sani. The other runs the agent script.

If Chrome offers to sign you into Chrome itself, dismiss it. That prompt is the browser, not Sani.

## 15-second hook

Say:

> Sani sits between a coding agent and the credentials it wants. The agent never holds the platform token. It asks for one call, you approve that exact call in the browser, and it gets a screened result. The demo you are about to see stores no credential and cannot reach the network.

## Two-minute walkthrough

### 1. Start Sani in demo mode

With Docker, use `v1.0.0-rc.6` or later. Earlier images do not have demo mode. The recording did not use Docker.

```sh
docker run --name sani --init -d \
  -e SANI_DEMO=1 \
  -p 127.0.0.1:8765:8765 \
  -v sani-data:/app/data \
  ghcr.io/sianachi/sani
docker logs sani
```

If the password is not there yet, run `docker logs sani` again. A later container on the same volume does not print the password again. It is in `sani.env` in the volume, mode 600.

From a checkout, which is what the video shows, leave this running in the first terminal:

```sh
mkdir -p /tmp/sani-demo
SANI_DEMO=1 \
SANI_DB=/tmp/sani-demo/sani.sqlite \
SANI_HOST=127.0.0.1 \
SANI_PORT=8765 \
SANI_ORIGIN=http://127.0.0.1:8765 \
node src/index.ts
```

You should see these, in this order:

- `Sani is ready at http://127.0.0.1:8765`
- `Demo mode is on. The built-in demo connection stores no credential and cannot reach other systems.`
- A line saying whether sandbox commands are on
- `First run: your operator password is`, followed by a generated password

The password and a new encryption key are saved in `sani.env` beside the database. The key is not printed. A later start prints where that file is instead of the password.

Say:

> First boot. Sani generated the operator password and printed it once. Demo mode is on, so there is a built-in connection with no credential.

If you set both `SANI_ADMIN_PASSWORD` and `SANI_ENCRYPTION_KEY` yourself, Sani uses those and does not write a secrets file. For the demo, leave them unset so the audience sees the first-run password.

### 2. Sign in and show the demo connection

Open <http://127.0.0.1:8765>. The yellow banner says demo mode, and that the built-in connection stores no credential and cannot reach the network or other systems.

Type the password from the log into **Operator password**. Click **Sign in**.

On the console, point at the card named `demo`:

- “Built-in demo. No credential. Calls stay inside Sani and cannot reach other systems.”
- Tools `lookup_ticket` and `echo`, both enabled
- No URL and no “replace token” control

The sandbox panel says the sandbox is off unless the host has a sandbox image. Leave it off.

Say:

> This connection is not a remote server. Approving a call here runs it inside Sani. Nothing is sent to GitHub, Linear, or anywhere else.

### 3. Create an agent token

In **Agents**, type a name such as `editor`. Click **Create agent token**.

Sani shows the token once, on a page with ready-made setup for Claude Code, Codex and other MCP clients. The token itself is under **Token only**. It looks like `sani_` plus a random string. Copy it. Going back does not show it again. The database stores a hash, not the token.

Say:

> This is the only secret the agent gets. It can ask for a call. It cannot approve one, and it is not a credential for any other system.

### 4. Ask for a ticket

In the second terminal, from the repo:

```sh
export SANI_AGENT_KEY='paste the sani_ token'
scripts/try-demo.sh
```

`SANI_URL` defaults to `http://127.0.0.1:8765`. The script calls the demo tool `lookup_ticket` with `{"id":"1001"}`. It prints JSON whose status is `pending`, then a line you can read out:

```text
Approve this request in your browser:
http://127.0.0.1:8765/requests/<id>
Waiting for a decision...
```

Leave the script running. It polls until you decide.

Say:

> The agent has asked. Sani has not run the tool. It is waiting for a person.

### 5. Approve that call

Open the approval URL in the same browser. Check the page before you click:

- Title **Demo request**
- Status **Pending**
- Connection **Demo (built-in)**
- Endpoint **None. This call stays inside Sani.**
- Tool `lookup_ticket`
- Inputs `{"id":"1001"}`
- The note that approving does not use a credential or contact another system

Click **Approve and run**. Do not click **Decline** unless you are showing what a refusal looks like. A decline is final.

The status becomes **Succeeded**. The result includes ticket `1001`, title **Welcome to Sani**, state `open`, and a detail that this is demo data and that approving does not contact another system.

The terminal then prints the same screened result and the script exits. The agent received the result. It still does not hold a platform token, because the demo has none.

Say:

> That approval was for this tool and these arguments. The result came back screened. In this demo there was no credential to hide, and no network call to make.

## 30-second fallback

If the wifi drops or `docker pull` fails, do not debug it in front of people. Play [demo.mp4](demo.mp4) from this folder. It is about 60 seconds.

Say:

> This is a recording of the same path, from source, because that is the program the container runs. First boot prints the password once, the demo connection is labelled, the agent asks for ticket 1001, and the call waits until it is approved. The result is sample data. The password in the recording belonged to a throwaway process and has been discarded.

Then stop. Offer to run it live after the wifi is back.

## Likely questions

### Can I put a GitHub token in it today?

You can connect a real platform on a machine you control. There is one operator account and no built-in sign-in throttling, so a real deployment belongs behind a reverse proxy that rate-limits and serves HTTPS. Demo mode does not relax the checks on any other connection. Turn demo mode off before you rely on Sani for real credentials.

### The agent has a key. Can it approve its own calls, or read the token Sani stores?

No. Approval is a browser action for a signed-in operator. The agent key can list enabled actions, request one, and read the result of its own request. Bearer tokens and OAuth tokens stay encrypted on the server. The agent is not given them. The demo connection has no token at all.

### What if I walk away? Is there an auto-approve?

There is no auto-approve. A pending request expires after 15 minutes. One approval dispatches that call once. Decline, expiry, and an unknown outcome are final. If you change the credential or the tool, waiting requests for that connection are invalidated.

### Is the sandbox running in this demo?

No. The console says the sandbox is off. Shell commands run only when the host has Docker and a sandbox image. The published image does not contain Docker, so the sandbox stays off in this demo. The demo tools are `lookup_ticket` and `echo`. They return fixed sample data inside the process.

### The password was on the screen. Where does it live, and what does screening actually stop?

On first boot, with no password and no key in the environment, Sani writes both to `sani.env` next to the database, mode 600, and prints the password once. Anyone who can read that log can sign in. A copy of the data volume is a copy of the encryption key. For a real deployment, set `SANI_ADMIN_PASSWORD` and `SANI_ENCRYPTION_KEY` from outside the volume so Sani does not write that file. If you lose the key, you cannot decrypt enrolled connections. You create new ones.

Screening withholds stored credentials from tool definitions, arguments, and results, including plain text, URL-encoding, base64, and base64url. It is not a general secret scanner. Request arguments and results are stored as plain JSON, so protect the database file. The demo result is sample text: “Welcome to Sani”.
