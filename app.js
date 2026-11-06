import { stamp, dur, fileName, toMarkdown, b64utf8, parseJSON, splitText } from './lib.js';

const SEG_MS = 5 * 60 * 1000;          // 5 dk'lık parça: Groq'un 25 MB sınırının çok altında
const STT_MODEL = 'whisper-large-v3-turbo';
const LLM_MODEL = 'openai/gpt-oss-20b';
const API = 'https://api.groq.com/openai/v1/';
const TAGS = ['Ders', 'Fikir', 'Kişisel', 'Hatırlatıcı', 'Proje', 'Toplantı']; // sabit liste: kategoriler dağılmasın
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
let stream, rec, noteId, seg, segTimer, t0, ticker, wake;

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
  const id = noteId, seconds = (Date.now() - t0) / 1000;
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const n = await getNote(id);
    await putNote({ ...n, seconds, status: 'islenecek' });
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

async function transcribe(blob) {
  const f = new FormData();
  f.append('file', blob, blob.type.includes('mp4') ? 'ses.mp4' : 'ses.webm');
  f.append('model', STT_MODEL);
  f.append('language', 'tr');
  return (await groq('audio/transcriptions', f)).text.trim();
}

const PROMPT = `Sen bir not asistanısın. Kullanıcının Türkçe sesli notunun dökümünü alırsın (ders kaydı, anlık fikir, hatırlatma olabilir).
Sadece şu JSON'u döndür:
{"baslik": "en fazla 8 kelimelik başlık",
 "etiketler": ["1-3 etiket, YALNIZCA şunlardan: ${TAGS.join(', ')}"],
 "ozet": "1-3 cümlelik özet",
 "maddeler": ["önemli noktalar; kısa notlarda boş dizi, uzun kayıtlarda en fazla 10 madde"]}`;

async function analyze(text) {
  const r = await groq('chat/completions', {
    model: LLM_MODEL,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
  });
  const j = parseJSON(r.choices[0].message.content);
  const tags = [...new Set((j.etiketler || []).map(t => TAGS.find(x => x.toLocaleLowerCase('tr') === String(t).toLocaleLowerCase('tr')) || t))];
  return { title: j.baslik, tags, summary: j.ozet || '', bullets: j.maddeler || [] };
}

async function processNote(id) {
  const n = await getNote(id);
  n.status = 'isleniyor';
  await putNote(n); render();
  try {
    const chunks = await chunksOf(id);
    const segs = [...new Set(chunks.map(c => c.seg))].sort((a, b) => a - b);
    n.parts ||= [];
    for (const s of segs) {
      if (n.parts[s] != null) continue;            // tekrar denemede çevrilmiş parçaları atla
      status(`Yazıya çevriliyor ${s + 1}/${segs.length}`);
      const blobs = chunks.filter(c => c.seg === s).map(c => c.blob);
      n.parts[s] = await transcribe(new Blob(blobs, { type: blobs[0].type }));
      await putNote(n);
    }
    n.text = n.parts.join(' ').trim();
    if (!n.text) Object.assign(n, { title: '(boş kayıt)', tags: [] });
    else {
      status('Düzenleniyor…');
      const pieces = splitText(n.text, 9000);
      if (pieces.length === 1) Object.assign(n, await analyze(n.text));
      else {
        // uzun ders: önce parçaları özetle, sonra özetlerin özetini çıkar
        const partial = [];
        for (const p of pieces) { const a = await analyze(p); partial.push(a.summary, ...a.bullets); }
        Object.assign(n, await analyze(partial.join('\n')));
      }
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

// ---------- Obsidian'a sync (GitHub deposu üzerinden) ----------
async function sync() {
  const token = cfg('ghToken'), repo = cfg('ghRepo');
  if (!token || !repo) return openSettings('Sync için GitHub anahtarı ve depo adı gerekli.');
  const todo = (await allNotes()).filter(n => n.status === 'hazir' && !n.synced);
  if (!todo.length) return status('Gönderilecek yeni not yok.');
  for (const [i, n] of todo.entries()) {
    status(`Obsidian'a gönderiliyor ${i + 1}/${todo.length}`);
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(fileName(n))}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ message: 'Not: ' + n.title, content: b64utf8(toMarkdown(n)) }),
    });
    if (!r.ok && r.status !== 422) return status(`GitHub hatası ${r.status}. Anahtarı/depoyu kontrol et.`); // 422 = dosya zaten var
    n.synced = true;
    await putNote(n);
  }
  status(`${todo.length} not gönderildi.`);
  render();
}

// ---------- Arayüz ----------
function status(t) { $('#status').textContent = t; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { kayit: 'kayıtta', islenecek: 'sırada', isleniyor: 'işleniyor…', hata: 'hata — dokun' };

const item = n => `
    <li><button class="item" data-id="${n.id}">
      <span class="meta">${stamp(n.created)} · ${dur(n.seconds || 0)}${n.synced ? ' · ✓' : ''}</span>
      <span class="title">${esc(n.title || LABEL[n.status] || 'Not')}</span>
      ${n.tags?.length ? `<span class="tags">${n.tags.map(t => `<i>${esc(t)}</i>`).join('')}</span>` : ''}
    </button></li>`;

async function render() {
  const notes = (await allNotes()).sort((a, b) => b.created - a.created);
  const waiting = notes.filter(n => n.status === 'hazir' && !n.synced).length;
  $('#sync').textContent = waiting ? `Sync (${waiting})` : 'Sync';
  if (!notes.length) return ($('#list').innerHTML = '<p class="empty">Henüz not yok. Dokun ve konuş.</p>');
  // Birden çok etiketi olan not her kategorisinde görünür
  const groups = new Map([...TAGS, 'Diğer'].map(t => [t, []]));
  for (const n of notes) {
    const ts = n.status === 'hazir' ? (n.tags?.length ? n.tags : ['Diğer']) : ['İşleniyor'];
    for (const t of ts) (groups.get(t) || groups.set(t, []).get(t)).push(n);
  }
  const open = JSON.parse(localStorage.getItem('open') || '[]');
  $('#list').innerHTML = [...groups].filter(([, ns]) => ns.length).map(([t, ns]) => `
    <details data-tag="${esc(t)}" ${open.includes(t) ? 'open' : ''}>
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
    <p class="meta">${stamp(n.created)} · ${dur(n.seconds || 0)}</p>
    <h2>${esc(n.title || LABEL[n.status])}</h2>
    ${n.tags?.length ? `<p class="tags">${n.tags.map(t => `<i>${esc(t)}</i>`).join('')}</p>` : ''}
    ${n.error ? `<p class="err">${esc(n.error)}</p>` : ''}
    ${n.summary ? `<blockquote>${esc(n.summary)}</blockquote>` : ''}
    ${n.bullets?.length ? `<ul>${n.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${n.text ? `<h3>Döküm</h3><p class="text">${esc(n.text)}</p>` : ''}
    ${segs.map(s => {
      const b = chunks.filter(c => c.seg === s).map(c => c.blob);
      return `<audio controls preload="none" src="${URL.createObjectURL(new Blob(b, { type: b[0].type }))}"></audio>`;
    }).join('')}`;
  $('#retry').hidden = n.status !== 'hata';
  $('#share').hidden = n.status !== 'hazir';
  $('#detail').showModal();
}

function openSettings(msg) {
  $('#settings-msg').textContent = msg || '';
  for (const k of ['groqKey', 'ghToken', 'ghRepo']) $('#' + k).value = cfg(k);
  $('#settings').showModal();
}

$('#rec').onclick = () => (document.body.classList.contains('rec') ? stopRec() : startRec());
$('#sync').onclick = () => sync().catch(e => status(e.message));
$('#gear').onclick = () => openSettings();
$('#list').addEventListener('toggle', () => localStorage.setItem('open', JSON.stringify([...document.querySelectorAll('#list details[open]')].map(d => d.dataset.tag))), true);
$('#list').onclick = e => { const b = e.target.closest('.item'); if (b) openNote(b.dataset.id); };
$('#save').onclick = () => { for (const k of ['groqKey', 'ghToken', 'ghRepo']) localStorage.setItem(k, $('#' + k).value.trim()); };
$('#close').onclick = () => $('#detail').close();
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
