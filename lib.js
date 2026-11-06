// Saf yardımcılar (tarayıcı + node testinde ortak)

export const pad = n => String(n).padStart(2, '0');

export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const dur = s => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

export function fileName(note) {
  const t = (note.title || 'Not').replace(/[\\/:*?"<>|#^[\]]/g, '').trim().slice(0, 60);
  return `${stamp(note.created).replace(':', '')} ${t}.md`;
}

const tag = t => t.toLocaleLowerCase('tr').replace(/\s+/g, '-');

export function toMarkdown(n) {
  const md = [
    '---',
    `tarih: ${stamp(n.created)}`,
    `sure: ${dur(n.seconds || 0)}`,
    `tags: [${(n.tags || []).map(tag).join(', ')}]`,
    '---',
    `# ${n.title || 'Not'}`,
    '',
  ];
  if (n.summary) md.push(`> ${n.summary}`, '');
  for (const b of n.bullets || []) md.push(`- ${b}`);
  if (n.bullets?.length) md.push('');
  md.push('## Döküm', '', n.text || '');
  return md.join('\n');
}

// GitHub API base64 ister; Türkçe karakterler için UTF-8 üzerinden
export function b64utf8(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Model bazen JSON'u metinle sarar; ilk {...} bloğunu al
export function parseJSON(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI cevabı JSON değil');
  return JSON.parse(m[0]);
}

// Uzun dökümü ücretsiz kotaya (8K token/dk) sığacak parçalara böl, cümle sınırında
export function splitText(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
