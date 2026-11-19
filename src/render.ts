const entities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
export const esc = (text: string) => text.replace(/[&<>"']/g, character => entities[character] ?? '');

// The console allows this one script by hash. It copies the text held next to a copy button.
export const copyScript = `document.addEventListener('click',function(e){var b=e.target.closest('button[data-copy]');if(!b)return;`
  + `navigator.clipboard.writeText(b.nextElementSibling.value).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})});`;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRows = (value: unknown): value is Json[] => Array.isArray(value) && value.length > 0 && value.every(isObject);
const compact = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? '';

const copyIcon = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">'
  + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';

/** The exact command, one numbered line per line. Long lines wrap so nothing sits off screen during review. */
export function commandView(command: string, label = 'sh'): string {
  const lines = command.replace(/\n$/, '').split('\n');
  return `<div class="cmd"><div class="cmd-bar"><span>${esc(label)} · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}</span>`
    + `<button type="button" data-copy class="icon" aria-label="Copy" title="Copy">${copyIcon}</button>`
    + `<textarea hidden readonly>${esc(command)}</textarea></div>`
    + `<pre><code>${lines.map(line => `<span class="l">${esc(line)}</span>`).join('')}</code></pre></div>`;
}

function copy(label: string, text: string): string {
  return `<button type="button" data-copy>${esc(label)}</button><textarea hidden readonly>${esc(text)}</textarea>`;
}

/** JSON, or one JSON value per line, or undefined for plain text. */
function parse(text: string): unknown {
  const trimmed = text.trim();
  // Bare numbers and words are text. Only output that opens a structure, after any null lines, is JSON.
  if (!/^(null\s*\n\s*)*[[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { /* try one value per line */ }
  try {
    // A null line carries nothing to show.
    return trimmed.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown).filter(item => item !== null);
  } catch {
    return undefined;
  }
}

function cell(value: unknown): string {
  if (value === undefined) return '<td></td>';
  if (typeof value === 'number') return `<td class="num">${esc(String(value))}</td>`;
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    // Short values such as dates and ids stay on one line; the table scrolls sideways if it must.
    const text = String(value);
    return `<td${text.length <= 24 ? ' class="tight"' : ''}>${esc(text)}</td>`;
  }
  return `<td><code>${esc(compact(value))}</code></td>`;
}

function tsvCell(value: unknown): string {
  const text = (value === undefined ? '' : compact(value)).replace(/[\t\r\n]+/g, ' ');
  // Text that a spreadsheet would run as a formula is pasted as text.
  return typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function table(rows: Json[]): string {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const tsv = [columns, ...rows.map(row => columns.map(column => tsvCell(row[column])))]
    .map(line => line.join('\t')).join('\n');
  return `<div class="row">${copy('Copy table', tsv)}<small>${rows.length} ${rows.length === 1 ? 'row' : 'rows'}</small></div>
<div class="scroll"><table><thead><tr>${columns.map(column => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(row => `<tr>${columns.map(column => cell(row[column])).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function view(value: unknown, depth = 0): string {
  if (typeof value === 'string') {
    const parsed = depth < 3 ? parse(value) : undefined;
    return parsed === undefined ? `<pre>${esc(value)}</pre>` : view(parsed, depth + 1);
  }
  if (isRows(value)) return table(value);
  if (depth >= 3 || !value || typeof value !== 'object') return `<pre>${esc(compact(value))}</pre>`;
  if (Array.isArray(value)) {
    return value.length === 0 ? '<p><small>Empty list</small></p>'
      : `<ul>${value.map(item => `<li>${isObject(item) || Array.isArray(item) ? view(item, depth + 1) : esc(compact(item))}</li>`).join('')}</ul>`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '<p><small>Empty object</small></p>';
  return `<div class="scroll"><table class="fields"><tbody>${entries.map(([key, item]) =>
    `<tr><th scope="row">${esc(key)}</th>${item !== null && typeof item === 'object'
      ? `<td>${view(item, depth + 1)}</td>` : cell(item)}</tr>`).join('')}</tbody></table></div>`;
}

/** A stored request result as HTML: tables where the data has that shape, text otherwise, and always the raw JSON. */
export function renderResult(result: unknown): string {
  let body: string;
  if (isObject(result) && typeof result.output === 'string' && 'exitCode' in result) {
    // A sandbox command: { exitCode, output, truncated }.
    body = `<p>Exit code <code>${esc(String(result.exitCode))}</code>${result.truncated ? ' · output cut at the size limit' : ''}</p>
${result.output ? view(result.output) : '<p><small>No output</small></p>'}`;
  } else if (isObject(result) && Array.isArray(result.text)) {
    // A platform tool: { data?, text[] }. Platforms often repeat the data as text, so show it once.
    const texts = result.text.filter(item => typeof item === 'string' && item.trim());
    body = result.data !== undefined ? view(result.data)
      : texts.map(item => view(item)).join('') || '<p><small>No content</small></p>';
  } else {
    body = view(result);
  }
  const raw = JSON.stringify(result, null, 2) ?? '';
  return `<div class="stack result">${body}
<details><summary>Raw result</summary><div class="row">${copy('Copy JSON', raw)}</div><pre>${esc(raw)}</pre></details></div>`;
}
