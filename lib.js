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
    ...(n.remind ? [`hatirlatma: ${n.remind.replace('T', ' ')}`] : []),
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

// ---------- Takvim (hatırlatıcı) ----------
// remind: 'YYYY-MM-DDTHH:MM' yerel saat; etkinlik 30 dk, bildirim tam saatinde
export const isRemind = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s || '');
const cal = (s, addMin = 0) => {
  const d = new Date(s);
  d.setMinutes(d.getMinutes() + addMin);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
};
const icsText = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');

export function icsFor(n) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sesli Not//TR', 'BEGIN:VEVENT',
    `UID:${n.id}@sesli-not`, `DTSTAMP:${cal(new Date().toISOString().slice(0, 16))}Z`,
    `DTSTART:${cal(n.remind)}`, `DTEND:${cal(n.remind, 30)}`,
    `SUMMARY:${icsText(n.title)}`, `DESCRIPTION:${icsText(n.summary || n.text)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(n.title)}`, 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export const gcalUrl = n => 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
  action: 'TEMPLATE', text: n.title || 'Hatırlatma', dates: `${cal(n.remind)}/${cal(n.remind, 30)}`, details: n.summary || n.text || '',
});
