import { stamp, dur, fileName, toMarkdown, b64utf8, parseJSON, splitText, highlights, groupKey, isRemind, icsFor, gcalUrl, isTrEn } from './lib.js';

const SEG_MS = 5 * 60 * 1000;          // 5 dk'lık parça: Groq'un 25 MB sınırının çok altında
const STT_MODEL = 'whisper-large-v3-turbo';
const LLM_MODEL = 'openai/gpt-oss-20b';
const API = 'https://api.groq.com/openai/v1/';
const TAGS = ['Ders', 'Fikir', 'Kişisel', 'Hatırlatıcı', 'Proje', 'Toplantı']; // sabit liste: kategoriler dağılmasın
const KEYS = ['groqKey', 'ghToken', 'ghRepo', 'notionToken', 'notionDb', 'notionProxy'];
const $ = s => document.querySelector(s);
const cfg = k => localStorage.getItem(k) || '';

// ---------- IndexedDB ----------
const dbp = new Promise((ok, no) => {
  const r = indexedDB.open('sesli-not', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('notes', { keyPath: 'id' });
    r.result.createObjectStore('chunks', { autoIncrement: true }).createIndex('noteId', 'noteId');
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((ok, no) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => no(t.error);
  });
}
const putNote = n => tx('notes', 'readwrite', s => s.put(n));
const getNote = id => tx('notes', 'readonly', s => s.get(id));
const allNotes = () => tx('notes', 'readonly', s => s.getAll());
const chunksOf = id => tx('chunks', 'readonly', s => s.index('noteId').getAll(id));
const allChunks = () => tx('chunks', 'readonly', s => s.getAll());
async function deleteNote(id) {
  await tx('chunks', 'readwrite', s => {
    s.index('noteId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
      const c = e.target.result;
      if (c) { s.delete(c.primaryKey); c.continue(); }
    };
  });
  await tx('notes', 'readwrite', s => s.delete(id));
}

// ---------- Kayıt ----------
let stream, rec, noteId, seg, segTimer, t0, ticker, wake, marks = [];

async function startRec() {
  if (!cfg('groqKey')) return openSettings('Önce Groq anahtarını gir.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return status('Mikrofon izni verilmedi.');
  }
  noteId = String(Date.now());
  seg = 0;
  t0 = Date.now();
  marks = [];
  $('#mark').textContent = 'İşaret koy';
  await putNote({ id: noteId, created: t0, status: 'kayit' });
  startSeg();
  wake = await navigator.wakeLock?.request('screen').catch(() => null);
  document.body.classList.add('rec');
  ticker = setInterval(() => status(dur((Date.now() - t0) / 1000)), 500);
  status('00:00');
}

function startSeg() {
  const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  const s = seg, id = noteId;
  // 5 sn'de bir diske yaz: uygulama kapansa da kayıt kaybolmaz
  rec.ondataavailable = e => e.data.size && tx('chunks', 'readwrite', st => st.add({ noteId: id, seg: s, blob: e.data }));
  rec.start(5000);
  segTimer = setTimeout(() => { rec.stop(); seg++; startSeg(); }, SEG_MS);
}

function stopRec() {
  clearTimeout(segTimer);
  clearInterval(ticker);
  const id = noteId, seconds = (Date.now() - t0) / 1000, m = marks;
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const n = await getNote(id);
    await putNote({ ...n, seconds, marks: m, status: 'islenecek' });
    render();
    processNote(id);
  };
  rec.stop();
  wake?.release();
  document.body.classList.remove('rec');
  status('');
}

// ---------- Groq ----------
async function groq(path, body) {
  const form = body instanceof FormData;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(API + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg('groqKey'), ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form ? body : JSON.stringify(body),
    });
    if (r.status === 429) { status('Ücretsiz kota doldu, bekleniyor…'); await new Promise(f => setTimeout(f, 20000)); continue; }
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error('Groq kotası dolu, biraz sonra tekrar dene.');
}

// Zaman damgalı döküm: işaretlenen anların metnini bulmak için
async function transcribe(blob, offset, language) {
  const f = new FormData();
  f.append('file', blob, blob.type.includes('mp4') ? 'ses.mp4' : 'ses.webm');
  f.append('model', STT_MODEL);
  f.append('response_format', 'verbose_json');
  if (language) f.append('language', language);
  const r = await groq('audio/transcriptions', f);
  // Yalnızca Türkçe/İngilizce: başka dil sanırsa Türkçe olarak yeniden çevir
  if (!language && !isTrEn(r.language)) return transcribe(blob, offset, 'tr');
  return {
    text: r.text.trim(),
    segs: (r.segments || []).map(g => ({ start: g.start + offset, end: g.end + offset, text: g.text.trim() })),
  };
}

const PROMPT = `Sen bir not asistanısın. Kullanıcının sesli notunun dökümünü alırsın (ders kaydı, anlık fikir, hatırlatma olabilir). Cevabı Türkçe yaz.
Sadece şu JSON'u döndür:
{"baslik": "en fazla 8 kelimelik başlık",
 "etiketler": ["1-3 etiket, YALNIZCA şunlardan: ${TAGS.join(', ')}"],
 "ders": "dersin adı (Matematik, Fizik…) yalnızca açıkça anlaşılıyorsa, yoksa boş metin",
 "hatirlatma": "not bir hatırlatma içeriyor ve tarih/gün söylenmişse 'YYYY-MM-DDTHH:MM' (saat söylenmemişse 09:00); yoksa boş metin. Göreli ifadeleri (yarın, cuma) verilen bugünkü tarihe göre çevir",
 "ozet": "1-3 cümlelik özet",
 "maddeler": ["önemli noktalar; kısa notlarda boş dizi, uzun kayıtlarda en fazla 10 madde; kullanıcının işaretlediği bölümler mutlaka yer alsın"]}`;

async function analyze(text) {
  const r = await groq('chat/completions', {
    model: LLM_MODEL,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: `Bugün: ${new Date().toLocaleString('tr-TR', { dateStyle: 'full', timeStyle: 'short' })}

${text}` }],
  });
  const j = parseJSON(r.choices[0].message.content);
  const tags = [...new Set((j.etiketler || []).map(t => TAGS.find(x => x.toLocaleLowerCase('tr') === String(t).toLocaleLowerCase('tr')) || t))];
  return { title: j.baslik, tags, course: (j.ders || '').trim(), remind: isRemind(j.hatirlatma) ? j.hatirlatma : '', summary: j.ozet || '', bullets: j.maddeler || [] };
}

async function processNote(id) {
  const n = await getNote(id);
  n.status = 'isleniyor';
  await putNote(n); render();
  try {
    const chunks = await chunksOf(id);
    const segs = [...new Set(chunks.map(c => c.seg))].sort((a, b) => a - b);
    n.parts ||= [];
    n.segs ||= [];
    for (const s of segs) {
      if (n.parts[s] != null) continue;            // tekrar denemede çevrilmiş parçaları atla
      status(`Yazıya çevriliyor ${s + 1}/${segs.length}`);
      const blobs = chunks.filter(c => c.seg === s).map(c => c.blob);
      const t = await transcribe(new Blob(blobs, { type: blobs[0].type }), s * SEG_MS / 1000);
      n.parts[s] = t.text;
      n.segs[s] = t.segs;
      await putNote(n);
    }
    n.text = n.parts.join(' ').trim();
    n.highlights = highlights(n.marks, n.segs.flat());
    if (!n.text) Object.assign(n, { title: '(boş kayıt)', tags: [] });
    else {
      status('Düzenleniyor…');
      const marked = n.highlights.length ? '\n\nKullanıcının önemli diye işaretlediği bölümler:\n' + n.highlights.map(h => '- ' + h.text).join('\n') : '';
      const pieces = splitText(n.text, 9000);
      const course = n.course;                     // elle girilmiş ders adını koru
      if (pieces.length === 1) Object.assign(n, await analyze(n.text + marked));
      else {
        // uzun ders: önce parçaları özetle, sonra özetlerin özetini çıkar
        const partial = [];
        for (const p of pieces) { const a = await analyze(p); partial.push(a.summary, ...a.bullets); }
        Object.assign(n, await analyze(partial.join('\n') + marked));
      }
      if (course) n.course = course;
    }
    n.status = 'hazir';
    delete n.error;
  } catch (e) {
    n.status = 'hata';
    n.error = e.message;
  }
  await putNote(n);
  status('');
  render();
}

// ---------- Sync: Obsidian (GitHub deposu) + Notion ----------
const needsGh = n => cfg('ghToken') && !n.synced;
const needsNotion = n => cfg('notionToken') && !n.notionId;

async function ghPut(n) {
  const repo = cfg('ghRepo'), path = n.path || fileName(n);
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const headers = { Authorization: 'Bearer ' + cfg('ghToken'), Accept: 'application/vnd.github+json' };
  // Düzenlenen not aynı dosyanın üstüne yazılsın: varsa sha gerekir
  const old = await fetch(url, { headers, cache: 'no-store' });
  const sha = old.ok ? (await old.json()).sha : undefined;
  const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'Not: ' + n.title, content: b64utf8(toMarkdown(n)), sha }) });
  if (!r.ok) throw new Error(`GitHub hatası ${r.status}. Anahtarı/depoyu kontrol et.`);
  n.path = path;
  n.synced = true;
}

let notionSchema;
async function notion(path, method, body) {
  const r = await fetch(cfg('notionProxy').replace(/\/$/, '') + '/v1/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + cfg('notionToken'), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Notion hatası ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const rt = s => [{ type: 'text', text: { content: s } }];

async function notionPut(n) {
  notionSchema ||= (await notion('databases/' + cfg('notionDb'), 'GET')).properties;
  // Veritabanında hangi sütunlar varsa onları doldur; başlık sütunu her zaman vardır
  const props = {};
  for (const [name, p] of Object.entries(notionSchema)) {
    if (p.type === 'title') props[name] = { title: rt(n.title || 'Not') };
    else if (name === 'Etiketler' && p.type === 'multi_select') props[name] = { multi_select: (n.tags || []).map(t => ({ name: t })) };
    else if (name === 'Tarih' && p.type === 'date') props[name] = { date: { start: new Date(n.created).toISOString() } };
    else if (name === 'Ders' && p.type === 'select' && n.course) props[name] = { select: { name: n.course } };
  }
  const blocks = [];
  if (n.summary) blocks.push({ type: 'quote', quote: { rich_text: rt(n.summary) } });
  for (const b of n.bullets || []) blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(b) } });
  for (const h of n.highlights || []) blocks.push({ type: 'callout', callout: { rich_text: rt(`${dur(h.t)} — ${h.text}`) } });
  blocks.push({ type: 'heading_3', heading_3: { rich_text: rt('Döküm') } });
  // shortcut: Notion tek istekte 100 blok alır; döküm 2000'lik paragraflara bölünüp ~85'te kesilir (~2,5 saat). Daha uzunsa ek istek gerekir.
  for (const p of (n.text || '').match(/[\s\S]{1,2000}/g) || []) if (blocks.length < 100) blocks.push({ type: 'paragraph', paragraph: { rich_text: rt(p) } });
  const page = await notion('pages', 'POST', { parent: { database_id: cfg('notionDb') }, properties: props, children: blocks });
  n.notionId = page.id;
}

async function sync() {
  if (!cfg('ghToken') && !cfg('notionToken')) return openSettings('Sync için GitHub ya da Notion bilgilerini gir.');
  const todo = (await allNotes()).filter(n => n.status === 'hazir' && (needsGh(n) || needsNotion(n)));
  if (!todo.length) return status('Gönderilecek yeni not yok.');
  for (const [i, n] of todo.entries()) {
    status(`Gönderiliyor ${i + 1}/${todo.length}`);
    if (needsGh(n)) await ghPut(n);
    if (needsNotion(n)) await notionPut(n);
    await putNote(n);
  }
  status(`${todo.length} not gönderildi.`);
  render();
}

// ---------- Yedek ----------
const toB64 = b => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });

async function exportAll() {
  status('Yedek hazırlanıyor…');
  const chunks = await Promise.all((await allChunks()).map(async c => ({ noteId: c.noteId, seg: c.seg, data: await toB64(c.blob) })));
  const blob = new Blob([JSON.stringify({ v: 1, notes: await allNotes(), chunks })], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `not-yedek-${stamp(Date.now()).replace(/[ :]/g, '-')}.json` });
  a.click();
  status('Yedek indirildi.');
}

async function importAll(file) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.notes)) return status('Bu dosya bir not yedeği değil.');
  const have = new Set((await allNotes()).map(n => n.id));
  const fresh = data.notes.filter(n => !have.has(n.id));        // var olan notların üstüne yazma
  const ids = new Set(fresh.map(n => n.id));
  for (const n of fresh) await putNote(n);
  for (const c of data.chunks || []) {
    if (!ids.has(c.noteId)) continue;
    const blob = await (await fetch(c.data)).blob();
    await tx('chunks', 'readwrite', s => s.add({ noteId: c.noteId, seg: c.seg, blob }));
  }
  status(`${fresh.length} not geri yüklendi.`);
  render();
}

// ---------- Arayüz ----------
function status(t) { $('#status').textContent = t; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { kayit: 'kayıtta', islenecek: 'sırada', isleniyor: 'işleniyor…', hata: 'hata — dokun' };
const selected = new Set();
const selecting = () => document.body.classList.contains('sel');

const item = n => `
    <li><button class="item${selected.has(n.id) ? ' on' : ''}" data-id="${n.id}">
      <span class="meta">${stamp(n.created)} · ${dur(n.seconds || 0)}${n.course ? ' · ' + esc(n.course) : ''}${n.synced || n.notionId ? ' · ✓' : ''}</span>
      <span class="title">${esc(n.title || LABEL[n.status] || 'Not')}</span>
      ${n.tags?.length ? `<span class="tags">${n.tags.map(t => `<i>${esc(t)}</i>`).join('')}</span>` : ''}
    </button></li>`;

async function render() {
  const notes = (await allNotes()).sort((a, b) => b.created - a.created);
  const waiting = notes.filter(n => n.status === 'hazir' && (needsGh(n) || needsNotion(n))).length;
  $('#sync').textContent = waiting ? `Sync (${waiting})` : 'Sync';
  $('#courses').innerHTML = [...new Set(notes.map(n => n.course).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
  $('#selbar span').textContent = `${selected.size} seçili`;
  if (!notes.length) return ($('#list').innerHTML = '<p class="empty">Henüz not yok. Dokun ve konuş.</p>');
  const q = $('#q').value.trim().toLocaleLowerCase('tr');
  if (q) {
    const hit = notes.filter(n => [n.title, n.summary, n.text, n.course, ...(n.tags || [])].join(' ').toLocaleLowerCase('tr').includes(q));
    return ($('#list').innerHTML = hit.length ? `<ul>${hit.map(item).join('')}</ul>` : '<p class="empty">Sonuç yok.</p>');
  }
  // Birden çok etiketi olan not her kategorisinde görünür; dersler ders adına göre ayrılır
  const groups = new Map([...TAGS, 'Diğer'].map(t => [t, []]));
  for (const n of notes) {
    const ts = n.status === 'hazir' ? (n.tags?.length ? n.tags : ['Diğer']) : ['İşleniyor'];
    for (const t of ts) { const k = groupKey(t, n.course); (groups.get(k) || groups.set(k, []).get(k)).push(n); }
  }
  const open = JSON.parse(localStorage.getItem('open') || '[]');
  $('#list').innerHTML = [...groups].filter(([, ns]) => ns.length).map(([t, ns]) => `
    <details data-tag="${esc(t)}" ${open.includes(t) || selecting() ? 'open' : ''}>
      <summary><span>${esc(t)}</span><span class="meta">${ns.length}</span></summary>
      <ul>${ns.map(item).join('')}</ul>
    </details>`).join('');
}

let current;
async function openNote(id) {
  const n = current = await getNote(id);
  const chunks = await chunksOf(id);
  const segs = [...new Set(chunks.map(c => c.seg))];
  $('#detail-body').innerHTML = `
    <p class="meta">${stamp(n.created)} · ${dur(n.seconds || 0)}${n.course ? ' · ' + esc(n.course) : ''}</p>
    <h2>${esc(n.title || LABEL[n.status])}</h2>
    ${n.tags?.length ? `<p class="tags">${n.tags.map(t => `<i>${esc(t)}</i>`).join('')}</p>` : ''}
    ${n.error ? `<p class="err">${esc(n.error)}</p>` : ''}
    ${n.remind ? `<div class="remind"><b>⏰ ${new Date(n.remind).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}</b>
      <a class="btn" href="data:text/calendar;charset=utf-8,${encodeURIComponent(icsFor(n))}" download="hatirlatma.ics">Apple Takvim</a>
      <a class="btn" href="${esc(gcalUrl(n))}" target="_blank" rel="noopener">Google Takvim</a></div>` : ''}
    ${n.summary ? `<blockquote>${esc(n.summary)}</blockquote>` : ''}
    ${n.bullets?.length ? `<ul>${n.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${n.highlights?.length ? `<h3>İşaretli anlar</h3>${n.highlights.map(h => `<p class="mark"><b class="meta">${dur(h.t)}</b> ${esc(h.text)}</p>`).join('')}` : ''}
    ${n.text ? `<h3>Döküm</h3><p class="text">${esc(n.text)}</p>` : ''}
    ${segs.map(s => {
      const b = chunks.filter(c => c.seg === s).map(c => c.blob);
      return `<audio controls preload="none" src="${URL.createObjectURL(new Blob(b, { type: b[0].type }))}"></audio>`;
    }).join('')}`;
  $('#retry').hidden = n.status !== 'hata';
  $('#share').hidden = $('#edit').hidden = n.status !== 'hazir';
  $('#detail').showModal();
}

function editNote() {
  const n = current;
  $('#detail-body').innerHTML = `
    <div class="erow"><h2>Düzenle</h2><button id="e-save">Kaydet</button></div>
    <label>Başlık <input id="e-title" value="${esc(n.title)}"></label>
    <label>Etiketler (virgülle) <input id="e-tags" value="${esc((n.tags || []).join(', '))}"></label>
    <label>Ders adı <input id="e-course" list="courses" value="${esc(n.course)}" placeholder="ör. Matematik"></label>
    <label>Hatırlatma zamanı <input id="e-remind" type="datetime-local" value="${esc(n.remind)}"></label>
    <label>Özet <textarea id="e-summary" rows="3">${esc(n.summary)}</textarea></label>
    <label>Maddeler (her satır bir madde) <textarea id="e-bullets" rows="5">${esc((n.bullets || []).join('\n'))}</textarea></label>
    <label>Döküm <textarea id="e-text" rows="10">${esc(n.text)}</textarea></label>`;
  $('#edit').hidden = true;
  $('#e-save').onclick = async () => {
    const v = id => $('#' + id).value.trim();
    Object.assign(n, {
      title: v('e-title') || 'Not',
      tags: v('e-tags').split(',').map(s => s.trim()).filter(Boolean),
      course: v('e-course'),
      remind: isRemind(v('e-remind')) ? v('e-remind') : '',
      summary: v('e-summary'),
      bullets: v('e-bullets').split('\n').map(s => s.trim()).filter(Boolean),
      text: v('e-text'),
      synced: false,                    // Obsidian'daki dosya güncellensin
    });
    await putNote(n);
    render();
    openNote(n.id);
  };
}

function openSettings(msg) {
  $('#settings-msg').textContent = msg || '';
  for (const k of KEYS) $('#' + k).value = cfg(k);
  $('#settings').showModal();
}

function setSelecting(on) {
  document.body.classList.toggle('sel', on);
  selected.clear();
  render();
}

$('#rec').onclick = () => (document.body.classList.contains('rec') ? stopRec() : startRec());
$('#mark').onclick = () => { marks.push((Date.now() - t0) / 1000); $('#mark').textContent = `İşaret koy (${marks.length})`; };
$('#sync').onclick = () => sync().catch(e => { status(e.message); render(); });
$('#q').oninput = render;
$('#gear').onclick = () => openSettings();
$('#selbtn').onclick = () => setSelecting(!selecting());
$('#selcancel').onclick = () => setSelecting(false);
$('#selall').onclick = async () => { (await allNotes()).forEach(n => selected.add(n.id)); render(); };
$('#seldel').onclick = async () => {
  if (!selected.size || !confirm(`${selected.size} not ve ses kayıtları silinsin mi?`)) return;
  for (const id of selected) await deleteNote(id);
  setSelecting(false);
};
$('#list').addEventListener('toggle', () => selecting() || localStorage.setItem('open', JSON.stringify([...document.querySelectorAll('#list details[open]')].map(d => d.dataset.tag))), true);
$('#list').onclick = e => {
  const b = e.target.closest('.item');
  if (!b) return;
  if (!selecting()) return openNote(b.dataset.id);
  const id = b.dataset.id;
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
};
$('#save').onclick = () => { for (const k of KEYS) localStorage.setItem(k, $('#' + k).value.trim()); notionSchema = null; render(); };
$('#export').onclick = e => { e.preventDefault(); exportAll().catch(err => status(err.message)); };
$('#import').onchange = e => { const f = e.target.files[0]; if (f) importAll(f).catch(err => status('Yedek okunamadı: ' + err.message)); $('#settings').close(); };
$('#close').onclick = () => $('#detail').close();
$('#edit').onclick = editNote;
$('#retry').onclick = () => { $('#detail').close(); processNote(current.id); };
$('#share').onclick = async () => {
  const text = toMarkdown(current);
  if (navigator.share) navigator.share({ title: current.title, text }).catch(() => {});
  else { await navigator.clipboard.writeText(text); status('Panoya kopyalandı.'); }
};
$('#del').onclick = async () => {
  if (!confirm('Bu not ve ses kaydı silinsin mi?')) return;
  await deleteNote(current.id);
  $('#detail').close();
  render();
};

// Açılışta: yarım kalan kayıtları ve işlenmemiş notları işle
(async () => {
  if (cfg('groqKey')) for (const n of await allNotes()) if (['kayit', 'islenecek', 'isleniyor'].includes(n.status)) await processNote(n.id);
})();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
