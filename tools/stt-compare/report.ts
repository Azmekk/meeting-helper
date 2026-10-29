import type { Segment } from './types.ts';

export type ReportColumn = { name: string; model: string; segments: Segment[] };
export type ReportRow = Record<string, string | number>;

// A self-contained page: summary table, the audio, and one column per provider.
// Clicking a segment seeks the audio; the segment being played is highlighted.
export function renderReport(title: string, audioFile: string, rows: ReportRow[], columns: ReportColumn[]): string {
  const data = JSON.stringify({ audioFile, rows, columns }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STT Compare</title>
<style>
  :root { --bg: #f7f7f5; --panel: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd; --active: #fff3c4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #18181a; --panel: #222226; --text: #ececea; --muted: #9a9a95; --line: #34343a; --active: #4a3f12; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .sticky { position: sticky; top: 0; background: var(--bg); padding-bottom: 12px; z-index: 1; }
  table { border-collapse: collapse; margin-bottom: 12px; font-size: 13px; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  audio { width: 100%; }
  label { font-size: 13px; color: var(--muted); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .col { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px; max-height: 70vh; overflow-y: auto; }
  .col h2 { font-size: 15px; margin: 0 0 8px; }
  .col h2 small { color: var(--muted); font-weight: 400; }
  .seg { padding: 4px 6px; border-radius: 4px; cursor: pointer; }
  .seg:hover { outline: 1px solid var(--line); }
  .seg.active { background: var(--active); }
  .meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .spk { font-weight: 600; }
</style>
</head>
<body>
<div class="sticky">
  <h1></h1>
  <div id="summary"></div>
  <audio id="audio" controls preload="metadata"></audio>
  <label><input type="checkbox" id="follow" checked> Scroll with playback</label>
</div>
<div class="cols" id="cols"></div>
<script type="application/json" id="data">${data}</script>
<script>
  const { audioFile, rows, columns } = JSON.parse(document.getElementById('data').textContent);
  document.querySelector('h1').textContent = ${JSON.stringify(title).replace(/</g, '\\u003c')};
  const audio = document.getElementById('audio');
  audio.src = audioFile;

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  };
  const hue = (name) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  if (rows.length) {
    const table = document.createElement('table');
    const keys = Object.keys(rows[0]);
    const head = table.insertRow();
    for (const k of keys) { const th = document.createElement('th'); th.textContent = k; head.appendChild(th); }
    for (const r of rows) { const tr = table.insertRow(); for (const k of keys) tr.insertCell().textContent = r[k] ?? ''; }
    document.getElementById('summary').appendChild(table);
  }

  const lists = columns.map((col) => {
    const box = document.createElement('div');
    box.className = 'col';
    const h2 = document.createElement('h2');
    h2.textContent = col.name + ' ';
    const small = document.createElement('small');
    small.textContent = col.model;
    h2.appendChild(small);
    box.appendChild(h2);
    const els = col.segments.map((s) => {
      const el = document.createElement('div');
      el.className = 'seg';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const spk = document.createElement('span');
      spk.className = 'spk';
      spk.style.color = 'hsl(' + hue(s.speaker) + ' 60% 50%)';
      spk.textContent = s.speaker;
      meta.append(fmt(s.startMs) + ' – ' + fmt(s.endMs) + '  ', spk);
      const text = document.createElement('div');
      text.textContent = s.text;
      el.append(meta, text);
      el.onclick = () => { audio.currentTime = s.startMs / 1000; audio.play(); };
      box.appendChild(el);
      return el;
    });
    document.getElementById('cols').appendChild(box);
    return { segments: col.segments, els, current: -1 };
  });

  audio.addEventListener('timeupdate', () => {
    const ms = audio.currentTime * 1000;
    for (const l of lists) {
      const i = l.segments.findIndex((s) => s.startMs <= ms && ms < s.endMs);
      if (i === l.current) continue;
      if (l.current >= 0) l.els[l.current].classList.remove('active');
      l.current = i;
      if (i >= 0) {
        l.els[i].classList.add('active');
        if (document.getElementById('follow').checked) l.els[i].scrollIntoView({ block: 'nearest' });
      }
    }
  });
</script>
</body>
</html>
`;
}
