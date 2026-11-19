import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { commandView, copyScript, esc, renderResult } from './render.ts';

export interface PublicConnection {
  id: string;
  name: string;
  url: string;
  auth: 'bearer' | 'oauth';
  connected: boolean;
  tools: { name: string; enabled: boolean }[];
}

export interface Approval {
  id: string;
  agentName: string;
  connectionName: string;
  connectionUrl?: string;
  tool: string;
  args: Record<string, unknown>;
  /** Set for a sandbox command request. */
  command?: string;
  secrets?: string[];
  status: string;
  createdAt: number;
  expiresAt: number;
  result?: unknown;
}

export interface WebApp {
  publicOrigin: string;
  adminPassword: string;
  sessionKey: Buffer;
  listConnections(): PublicConnection[];
  createConnection(input: {
    name: string;
    url: string;
    auth: 'bearer' | 'oauth';
    token: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    scope: string;
  }): Promise<{ id: string; authorizationUrl?: string }>;
  refreshConnection(id: string): Promise<void>;
  enableTool(id: string, tool: string, enabled: boolean): void;
  deleteConnection(id: string): void;
  rotateToken(id: string, token: string): void;
  startOAuth(id: string): Promise<string>;
  finishOAuth(state: string, code: string): Promise<void>;
  listRequests(): Approval[];
  getRequest(id: string): Approval | undefined;
  decide(id: string, approve: boolean): Promise<Approval>;
  createAgent(name: string): { id: string; token: string };
  listAgents(): { id: string; name: string }[];
  revokeAgent(id: string): void;
  sandboxEnabled: boolean;
  listSecrets(): string[];
  setSecret(name: string, value: string): void;
  deleteSecret(name: string): void;
}

const css = `
:root{color-scheme:light;--paper:#f1f4fa;--ink:#172138;--muted:#485976;--rule:#b9c5d9;--accent:#2146af;--surface:#fff;--alert:#8d2b46}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 "Instrument Sans","Avenir Next",sans-serif}
header{border-top:5px solid var(--accent);border-bottom:1px solid var(--rule);background:var(--surface)}
header>div,main{width:min(65rem,100% - 3rem);margin-inline:auto}
header>div{display:flex;align-items:center;gap:1.25rem;justify-content:space-between;min-height:4.25rem}
header nav{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem}
.brand{color:var(--ink);font-size:1.5rem;font-weight:780;letter-spacing:-.06em;text-decoration:none}
a{color:var(--accent);text-underline-offset:.19em}
main{padding-block:2.5rem 4rem}
h1,h2,h3,p,ul,dl{margin:0}
h1{font-size:clamp(2rem,5.2vw,3.1rem);font-weight:760;letter-spacing:-.048em;line-height:1.09;margin-bottom:1rem}
h2{font-size:1.32rem;letter-spacing:-.025em;margin-bottom:.7rem}
h3{font-size:1.05rem;font-weight:700;overflow-wrap:anywhere}
p{max-width:60ch}
p+p{margin-top:.7rem}
section+section,.stack>*+*{margin-top:1.25rem}
.grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:2rem;align-items:start}
.panel{background:var(--surface);border:1px solid var(--rule);padding:1.2rem 1.35rem;border-radius:.35rem}
.panel>p,.hint{color:var(--muted)}
.panel form{margin-top:.7rem}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem}
.line{padding:.7rem 0;border-bottom:1px solid var(--rule)}
.line:last-child{border-bottom:0;padding-bottom:0}
.inline,header form{margin:0 !important}
.line .row{justify-content:space-between}
.line p{overflow-wrap:anywhere}
button,input,select{font:inherit}
label{display:grid;gap:.25rem;font-weight:650}
label+label{margin-top:.65rem}
input,select{width:100%;min-width:0;background:#fbfcff;color:var(--ink);border:1px solid #8d9bb3;border-radius:.24rem;padding:.47rem .64rem}
button{background:var(--surface);color:var(--ink);border:1px solid #8d9bb3;border-radius:.24rem;padding:.45rem .76rem;cursor:pointer;font-weight:650}
button:hover{background:#e1e9ff}
.primary{background:var(--accent);border-color:var(--accent);color:white}
.primary:hover{background:#17368c}
.link-button{display:inline-block;border-radius:.24rem;padding:.45rem .76rem;text-decoration:none;font-weight:650}
.danger{color:var(--alert)}
form>button.primary{margin-top:.75rem}
.row>button.primary{margin-top:0}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
small,time{font-size:.88rem}
small{color:var(--muted)}
pre,code{font-family:"IBM Plex Mono",ui-monospace,monospace;overflow-wrap:anywhere}
pre{padding:.78rem .9rem;margin:0;background:#eaf0fd;border-left:3px solid var(--accent);white-space:pre-wrap}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem .9rem}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
.narrow{max-width:43rem}
.auth{max-width:28rem}
details{margin-top:.7rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;vertical-align:top;padding:.38rem .55rem;border-bottom:1px solid var(--rule);overflow-wrap:break-word}
thead th{color:var(--muted);font-weight:650;white-space:nowrap;border-bottom:2px solid var(--rule)}
tbody tr:last-child>*{border-bottom:0}
.fields th{color:var(--muted);font-weight:500;width:1%;white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tight{white-space:nowrap}
.cmd{border-radius:.35rem;overflow:hidden;background:#131b2e;color:#e6ecfb}
.cmd-bar{display:flex;align-items:center;justify-content:space-between;padding:.3rem .45rem .3rem .9rem;background:#1e2942;color:#a9b8d6;font-size:.82rem}
.cmd pre{background:none;border:0;padding:.75rem .9rem .85rem 0;font-size:.9rem;line-height:1.6;counter-reset:l}
.cmd .l{display:block;position:relative;padding-left:3.1rem;min-height:1.6em;counter-increment:l}
.cmd .l::before{content:counter(l);position:absolute;left:0;width:2.2rem;text-align:right;color:#6f80a3;user-select:none}
.icon{display:inline-flex;align-items:center;gap:.3rem;background:none;border-color:transparent;color:inherit;padding:.3rem .4rem;font-size:.82rem}
.icon:hover{background:#2c3a5c}
.cmd+p{margin-top:.6rem}
.result ul{padding-left:1.2rem}
.result button{padding:.25rem .6rem;font-size:.88rem}
details summary{cursor:pointer;font-weight:650;color:var(--accent)}
@media(max-width:47rem){header>div,main{width:calc(100% - 2rem)}header>div{display:grid;grid-template-columns:1fr auto;gap:.45rem .8rem;padding-block:.55rem}header nav{grid-column:1/-1;grid-row:2}header form{grid-column:2;grid-row:1}.grid{grid-template-columns:1fr;gap:1.25rem}main{padding-top:1.5rem}}
`;

const cssHash = createHash('sha256').update(css).digest('base64');
const scriptHash = createHash('sha256').update(copyScript).digest('base64');
const durationSeconds = 8 * 60 * 60;
const bodyLimit = 32 * 1024;
const invalidForm = new Error('Invalid form');
const oversizedForm = new Error('Oversized form');

const requestPath = (id: string) => `/requests/${encodeURIComponent(id)}`;
const connectionPath = (id: string) => `/connections/${encodeURIComponent(id)}`;
const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const action = (path: string, label: string, className = '', fields = '') =>
  `<form class="inline" method="post" action="${esc(path)}">${fields}<button class="${className}">${esc(label)}</button></form>`;

function layout(title: string, content: string, signedIn: boolean): string {
  const nav = signedIn
    ? '<nav aria-label="Console"><a href="/#connections">Connections</a><a href="/#requests">Requests</a><a href="/#agents">Agents</a><a href="/#secrets">Secrets</a></nav>'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Sani</title>
<style>${css}</style></head><body><header><div><a class="brand" href="/">Sani</a>${nav}
${signedIn ? action('/logout', 'Sign out') : ''}</div></header><main>${content}</main><script>${copyScript}</script></body></html>`;
}

function render(res: ServerResponse, status: number, title: string, content: string, signedIn: boolean) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(layout(title, content, signedIn));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location });
  res.end();
}

function providerSignIn(res: ServerResponse, app: WebApp, authorizationUrl: string) {
  const destination = new URL(authorizationUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname);
  if (destination.username || destination.password
    || (destination.protocol !== 'https:' && !(loopback && !secure(app) && destination.protocol === 'http:'))) {
    throw invalidForm;
  }
  render(res, 200, 'Provider sign-in', `<div class="narrow stack"><h1>Provider sign-in</h1>
<p>Continue to ${esc(destination.host)} to authorize this connection.</p>
<p><a class="primary link-button" rel="noreferrer" href="${esc(destination.href)}">Continue to provider</a></p></div>`, true);
}

function sign(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

function constantEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function secure(app: WebApp): boolean {
  return new URL(app.publicOrigin).protocol === 'https:';
}

function cookieName(app: WebApp): string {
  return secure(app) ? '__Host-sani_session' : 'sani_session';
}

function setSession(res: ServerResponse, app: WebApp, issue: boolean) {
  const expires = Math.floor(Date.now() / 1000) + durationSeconds;
  const payload = `${expires}.${randomBytes(24).toString('base64url')}`;
  const value = issue ? `${payload}.${sign(app.sessionKey, payload)}` : '';
  res.setHeader('Set-Cookie',
    `${cookieName(app)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${issue ? durationSeconds : 0}${secure(app) ? '; Secure' : ''}`);
}

function isOperator(req: IncomingMessage, app: WebApp): boolean {
  const prefix = `${cookieName(app)}=`;
  const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(prefix));
  if (!cookie) return false;

  const parts = cookie.slice(prefix.length).split('.');
  const expires = Number(parts[0]);
  return parts.length === 3 && Number.isSafeInteger(expires) && expires > Math.floor(Date.now() / 1000)
    && constantEqual(parts[2] ?? '', sign(app.sessionKey, parts.slice(0, 2).join('.')));
}

function safeReturn(value: string): string {
  return /^\/requests\/[\w-]+$/.test(value) ? value : '/';
}

function login(res: ServerResponse, next: string, failed = false) {
  render(res, failed ? 401 : 200, 'Operator sign-in',
    `<div class="auth stack"><h1>Operator sign-in</h1>
${failed ? '<p role="alert">Check your operator password and try again.</p>' : ''}
<div class="panel"><form method="post" action="/login">${hidden('next', safeReturn(next))}
<label>Operator password<input type="password" name="password" maxlength="1024" autocomplete="current-password" required autofocus></label>
<button class="primary">Sign in</button></form></div></div>`, false);
}

function connectionCard(connection: PublicConnection): string {
  const path = connectionPath(connection.id);
  const toolRows = connection.tools.map(tool =>
    `<div class="line row"><code>${esc(tool.name)}</code>
${action(`${path}/tools`, tool.enabled ? 'Disable' : 'Enable', '', hidden('tool', tool.name) + hidden('enabled', String(!tool.enabled)))}</div>`).join('');
  const credentialAction = connection.auth === 'oauth'
    ? action(`${path}/oauth`, connection.connected ? 'Sign in again' : 'Sign in to provider')
    : `<details><summary>Replace token</summary><form method="post" action="${path}/rotate">
<label>New bearer token<input type="password" name="token" autocomplete="off" maxlength="8192" required></label>
<button class="primary">Replace token</button></form></details>`;

  return `<article class="panel"><h3>${esc(connection.name)}</h3>
<p><small>${esc(connection.url)}</small></p>
<p>${connection.connected ? 'Connected' : 'Connection needs sign-in'}</p>
<div class="row">${connection.connected ? action(`${path}/refresh`, 'Refresh tools') : ''}
${connection.auth === 'oauth' ? credentialAction : ''}
${action(`${path}/delete`, 'Remove connection', 'danger')}</div>
${connection.auth === 'bearer' ? credentialAction : ''}
${toolRows || '<p><small>No tools discovered yet.</small></p>'}</article>`;
}

function addConnectionForm(publicOrigin: string): string {
  const callback = new URL('/oauth/callback', publicOrigin).href;
  return `<form class="panel" method="post" action="/connections">
<h3>Add connection</h3>
<label>Connection name<input name="name" maxlength="80" required></label>
<label>MCP endpoint<input name="url" type="url" maxlength="2048" required></label>
<label>Authentication<select name="auth"><option value="bearer">Bearer token</option><option value="oauth">Browser sign-in (OAuth)</option></select></label>
<label>Bearer token <small>For token authentication</small><input type="password" name="token" autocomplete="off" maxlength="8192"></label>
<label>OAuth issuer URL <small>For browser sign-in</small><input name="issuer" type="url" maxlength="2048"></label>
<details class="stack"><summary>Optional OAuth settings</summary>
<p class="hint">If your provider asks you to register an app, use this callback URL in its settings.</p>
<pre><code>${esc(callback)}</code></pre>
<label>Client ID <small>From your registered app</small><input name="clientId" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="512"></label>
<label>Client secret <small>Enter it if your registered app has one.</small><input type="password" name="clientSecret" autocomplete="off" maxlength="8192"></label>
<label>OAuth scopes <small>Enter any scopes required by your provider.</small><input name="scope" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="2048"></label>
</details>
<button class="primary">Add connection</button></form>`;
}

function timestamp(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const iso = date.toISOString();
  return `<time datetime="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`;
}

function statusLabel(status: string): string {
  const spaced = status.replaceAll('_', ' ');
  return esc(spaced.charAt(0).toUpperCase() + spaced.slice(1));
}

function dashboard(res: ServerResponse, app: WebApp) {
  const connections = app.listConnections();
  const requests = app.listRequests();
  const agents = app.listAgents();
  const connectionRows = connections.map(connectionCard).join('');
  const requestRows = requests.map(request =>
    `<div class="line"><a href="${requestPath(request.id)}">${esc(request.connectionName)} <code>${esc(request.tool)}</code></a>
<p><small>${esc(request.agentName)} · ${statusLabel(request.status)} · ${timestamp(request.createdAt)}</small></p></div>`).join('');
  const agentRows = agents.map(agent =>
    `<div class="line"><div class="row"><h3>${esc(agent.name)}</h3>${action(`${agentPath(agent.id)}/revoke`, 'Revoke access', 'danger')}</div></div>`).join('');

  const secretRows = app.listSecrets().map(name =>
    `<div class="line row"><code>${esc(name)}</code>${action(`/secrets/${encodeURIComponent(name)}/delete`, 'Remove', 'danger')}</div>`).join('');
  const secrets = `<section id="secrets"><h2>Sandbox secrets</h2><div class="panel">
<p><small>${app.sandboxEnabled
    ? 'An approved command receives the secrets it names as environment variables.'
    : 'The sandbox is off. Set SANI_SANDBOX_IMAGE to let agents request commands.'}</small></p>${secretRows}
<form method="post" action="/secrets"><label>Name <small>For example GH_TOKEN</small><input name="name" maxlength="64" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
<label>Value<input type="password" name="value" autocomplete="off" maxlength="8192" required></label>
<button class="primary">Save secret</button></form></div></section>`;

  render(res, 200, 'Operator console', `<h1>Operator console</h1>
<div class="grid"><div><section id="connections" class="stack"><h2>Connections</h2>
${connectionRows}${addConnectionForm(app.publicOrigin)}</section></div>
<div><section id="requests"><h2>Requests</h2><div class="panel">${requestRows || '<p>Requests from your agents appear here.</p>'}</div></section>
<section id="agents"><h2>Agents</h2><div class="panel">${agentRows}
<form method="post" action="/agents"><label>Agent name<input name="name" maxlength="80" required></label>
<button class="primary">Create agent token</button></form></div></section>${secrets}</div></div>`, true);
}

function showRequest(res: ServerResponse, app: WebApp, id: string) {
  const pending = app.getRequest(id);
  if (!pending) {
    render(res, 404, 'Request unavailable', '<h1>Request unavailable</h1><p><a href="/#requests">View requests</a></p>', true);
    return;
  }

  const detail = (value: unknown) => esc(JSON.stringify(value, null, 2) ?? '');
  const controls = pending.status === 'pending' && pending.expiresAt > Date.now()
    ? `<div class="row">${action(`${requestPath(id)}/approve`, 'Approve and run', 'primary')}${action(`${requestPath(id)}/decline`, 'Decline', 'danger')}</div>`
    : '';
  const title = pending.command === undefined ? 'Tool request' : 'Command request';
  render(res, 200, title, `<div class="narrow stack"><a href="/#requests">All requests</a><h1>${title}</h1>
<section class="panel stack"><dl>
<dt>Status</dt><dd>${statusLabel(pending.status)}</dd>
<dt>Agent</dt><dd>${esc(pending.agentName)}</dd>
${pending.command === undefined ? `<dt>Connection</dt><dd>${esc(pending.connectionName)}</dd>
${pending.connectionUrl ? `<dt>Endpoint</dt><dd>${esc(pending.connectionUrl)}</dd>` : ''}
<dt>Tool</dt><dd><code>${esc(pending.tool)}</code></dd>` : `<dt>Runs in</dt><dd>Sandbox container</dd>
<dt>Secrets it receives</dt><dd>${pending.secrets?.length ? pending.secrets.map(name => `<code>${esc(name)}</code>`).join(' ') : 'None'}</dd>`}
<dt>Expires</dt><dd>${timestamp(pending.expiresAt)}</dd>
</dl>
${pending.command === undefined ? `<div><h2>Inputs</h2><pre>${detail(pending.args)}</pre></div>`
    : `<div><h2>Command</h2>${commandView(pending.command)}
<p><small>The command can send its secrets anywhere it can reach. Approve it only if you understand every part.</small></p></div>`}
${controls}
${pending.result === undefined ? '' : `<div><h2>Result</h2>${renderResult(pending.result)}</div>`}
</section></div>`, true);
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw invalidForm;
  if (Number(req.headers['content-length']) > bodyLimit) throw oversizedForm;

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw invalidForm;
    length += chunk.length;
    if (length > bodyLimit) throw oversizedForm;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function field(fields: URLSearchParams, name: string, max: number, required = true): string {
  const values = fields.getAll(name);
  const value = values[0] ?? '';
  if (values.length > 1 || value.length > max || (required && value.length === 0)) throw invalidForm;
  return value;
}

function errorPage(res: ServerResponse, status: number, title: string, message: string, signedIn: boolean) {
  render(res, status, title, `<div class="stack"><h1>${esc(title)}</h1><p role="alert">${esc(message)}</p><p><a href="/">Return to Sani</a></p></div>`, signedIn);
}

export async function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL, app: WebApp): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  // no-referrer would suppress the Origin header on native form submissions.
  res.setHeader('Referrer-Policy', url.pathname === '/oauth/callback' ? 'no-referrer' : 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'sha256-${cssHash}'; script-src 'sha256-${scriptHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  if (secure(app)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  const signedIn = isOperator(req, app);
  const path = url.pathname;
  try {
    if (req.method === 'GET') {
      if (path === '/oauth/callback') {
        if (!signedIn) {
          errorPage(res, 401, 'Sign in to finish connecting', 'Sign in to Sani, then start the provider sign-in again.', false);
          return;
        }
        await app.finishOAuth(field(url.searchParams, 'state', 500), field(url.searchParams, 'code', 4096));
        redirect(res, '/#connections');
        return;
      }
      if (!signedIn) {
        login(res, path);
        return;
      }
      if (path === '/') {
        dashboard(res, app);
        return;
      }
      const request = /^\/requests\/([\w-]+)$/.exec(path);
      if (request?.[1]) {
        showRequest(res, app, request[1]);
        return;
      }
    }

    if (req.method === 'POST') {
      if (req.headers.origin !== app.publicOrigin) {
        errorPage(res, 403, 'Request forbidden', 'Submit this action from the Sani console.', signedIn);
        return;
      }
      if (path !== '/login' && !signedIn) {
        errorPage(res, 401, 'Sign in to continue', 'Sign in to the Sani console before submitting this action.', false);
        return;
      }
      const fields = await form(req);
      const connection = /^\/connections\/([\w-]+)\/(refresh|delete|rotate|oauth|tools)$/.exec(path);
      const request = /^\/requests\/([\w-]+)\/(approve|decline)$/.exec(path);
      const revoke = /^\/agents\/([\w-]+)\/revoke$/.exec(path);
      const secret = /^\/secrets\/([A-Z0-9_]+)\/delete$/.exec(path);

      if (path === '/login') {
        const next = safeReturn(field(fields, 'next', 400, false));
        if (!constantEqual(field(fields, 'password', 1024), app.adminPassword)) {
          login(res, next, true);
          return;
        }
        setSession(res, app, true);
        redirect(res, next);
        return;
      }
      if (path === '/logout') {
        setSession(res, app, false);
        redirect(res, '/');
        return;
      }
      if (path === '/connections') {
        const auth = field(fields, 'auth', 10);
        if (auth !== 'bearer' && auth !== 'oauth') throw invalidForm;
        const clientId = auth === 'oauth' ? field(fields, 'clientId', 512, false) : '';
        const clientSecret = auth === 'oauth' ? field(fields, 'clientSecret', 8192, false) : '';
        if (clientSecret && !clientId.trim()) throw invalidForm;
        const created = await app.createConnection({
          name: field(fields, 'name', 80),
          url: field(fields, 'url', 2048),
          auth,
          token: field(fields, 'token', 8192, auth === 'bearer'),
          issuer: field(fields, 'issuer', 2048, auth === 'oauth'),
          clientId,
          clientSecret,
          scope: auth === 'oauth' ? field(fields, 'scope', 2048, false) : '',
        });
        if (created.authorizationUrl) providerSignIn(res, app, created.authorizationUrl);
        else redirect(res, '/#connections');
        return;
      }
      if (connection?.[1]) {
        const id = connection[1];
        switch (connection[2]) {
          case 'refresh': await app.refreshConnection(id); break;
          case 'delete': app.deleteConnection(id); break;
          case 'rotate': app.rotateToken(id, field(fields, 'token', 8192)); break;
          case 'tools': {
            const enabled = field(fields, 'enabled', 5);
            if (enabled !== 'true' && enabled !== 'false') throw invalidForm;
            app.enableTool(id, field(fields, 'tool', 256), enabled === 'true');
            break;
          }
          case 'oauth':
            providerSignIn(res, app, await app.startOAuth(id));
            return;
        }
        redirect(res, '/#connections');
        return;
      }
      if (request?.[1]) {
        await app.decide(request[1], request[2] === 'approve');
        redirect(res, requestPath(request[1]));
        return;
      }
      if (path === '/agents') {
        const agent = app.createAgent(field(fields, 'name', 80));
        render(res, 200, 'Agent token', `<div class="narrow stack"><h1>Agent token</h1>
<p>Copy this token into your agent’s MCP connection settings. This page displays it once.</p>
<pre><code>${esc(agent.token)}</code></pre><p><a href="/#agents">Return to agents</a></p></div>`, true);
        return;
      }
      if (path === '/secrets') {
        app.setSecret(field(fields, 'name', 64), field(fields, 'value', 8192));
        redirect(res, '/#secrets');
        return;
      }
      if (secret?.[1]) {
        app.deleteSecret(secret[1]);
        redirect(res, '/#secrets');
        return;
      }
      if (revoke?.[1]) {
        app.revokeAgent(revoke[1]);
        redirect(res, '/#agents');
        return;
      }
    }

    errorPage(res, 404, 'Page unavailable', 'Check the link and try again.', signedIn);
  } catch (error) {
    if (error === invalidForm) {
      errorPage(res, 400, 'Check the form', 'A required value is missing or invalid.', signedIn);
    } else if (error === oversizedForm) {
      req.resume();
      errorPage(res, 413, 'Form too large', 'Reduce the size of your input and try again.', signedIn);
    } else {
      errorPage(res, 400, 'Action failed', 'Check the connection and input, then try again.', signedIn);
    }
  }
}
