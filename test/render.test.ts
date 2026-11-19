import assert from 'node:assert/strict';
import test from 'node:test';

import { commandView, renderResult } from '../src/render.ts';

test('results render as tables where the data allows and stay escaped everywhere', () => {
  const lines = renderResult({
    exitCode: 0, truncated: false,
    output: 'null\n{"date":"2026-11-12","requests":552}\n{"date":"2026-11-13","requests":2529,"note":"=HYPERLINK(1)\\t<b>"}\n',
  });
  assert.match(lines, /<th scope="col">date<\/th><th scope="col">requests<\/th><th scope="col">note<\/th>/);
  assert.match(lines, /<td class="tight">2026-11-12<\/td><td class="num">552<\/td><td><\/td>/);
  assert.match(lines, /2 rows/);
  assert.equal(lines.includes('<b>'), false);
  // The copied table is tab-separated, one row per line, with formula text defused.
  assert.match(lines, /<textarea hidden readonly>date\trequests\tnote\n2026-11-12\t552\t\n2026-11-13\t2529\t&#39;=HYPERLINK\(1\) &lt;b&gt;<\/textarea>/);
  assert.match(lines, /Copy JSON/);

  const array = renderResult({ exitCode: 0, truncated: true, output: '[{"a":{"b":[1]}},{"c":true}]' });
  assert.match(array, /<code>\{&quot;b&quot;:\[1\]\}<\/code>/);
  assert.match(array, /output cut at the size limit/);

  const text = renderResult({ exitCode: 2, truncated: false, output: '[INFO] 3 files <script>alert(1)</script>\n42\n' });
  assert.match(text, /<pre>\[INFO\] 3 files &lt;script&gt;/);
  assert.equal(text.includes('<table'), false);
  assert.match(renderResult({ exitCode: 0, truncated: false, output: '' }), /No output/);

  const tool = renderResult({ data: { issue: { id: 'LIN-1', labels: ['bug', 'p1'] }, comments: [{ by: 'a' }] }, text: ['{"dup":1}'] });
  assert.match(tool, /<th scope="row">issue<\/th>/);
  assert.match(tool, /<li>bug<\/li><li>p1<\/li>/);
  assert.match(tool, /<th scope="col">by<\/th>/);
  assert.equal(tool.includes('<th scope="row">dup</th>'), false, 'text that repeats the data is shown once');
  assert.match(renderResult({ text: ['{"total":3}', 'plain words'] }), /<th scope="row">total<\/th><td class="num">3<\/td>[\s\S]*<pre>plain words<\/pre>/);

  let deep: unknown = 'bottom';
  for (let i = 0; i < 50; i += 1) deep = { next: deep };
  assert.match(renderResult(deep), /<pre>/);
  for (const odd of [null, 7, 'x', [], {}, [1, 'two', null]]) assert.match(renderResult(odd), /Raw result/);
});

test('the command view shows every line exactly and copies the original text', () => {
  const command = 'A="x <y>"\ncurl -s "$A" | jq .\n';
  const html = commandView(command);
  assert.match(html, /sh · 2 lines/);
  assert.match(html, /<span class="l">A=&quot;x &lt;y&gt;&quot;<\/span><span class="l">curl -s &quot;\$A&quot; \| jq \.<\/span><\/code>/);
  assert.match(html, /aria-label="Copy command"/);
  assert(html.includes(`<textarea hidden readonly>A=&quot;x &lt;y&gt;&quot;\ncurl -s &quot;$A&quot; | jq .\n</textarea>`));
  assert.match(commandView('ls'), /sh · 1 line</);
});
