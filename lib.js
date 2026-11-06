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
    ...(n.course ? [`ders: ${n.course}`] : []),
    '---',
    `# ${n.title || 'Not'}`,
    '',
  ];
  if (n.summary) md.push(`> ${n.summary}`, '');
  for (const b of n.bullets || []) md.push(`- ${b}`);
  if (n.bullets?.length) md.push('');
  if (n.highlights?.length) md.push('## İşaretli anlar', '', ...n.highlights.map(h => `- **${dur(h.t)}** ${h.text}`), '');
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

// İşaret anının 20 sn öncesi ile 5 sn sonrası arasındaki döküm parçası
export function highlights(marks, segs) {
  return (marks || []).map(t => ({
    t,
    text: segs.filter(g => g.end >= t - 20 && g.start <= t + 5).map(g => g.text).join(' ').trim(),
  })).filter(h => h.text);
}

// Ders etiketli notlar ders adına göre ayrı başlıkta toplanır
export const groupKey = (tag, course) => (tag === 'Ders' && course ? `Ders · ${course}` : tag);
