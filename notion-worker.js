// Cloudflare Worker: Notion API tarayıcıdan doğrudan çağrılamadığı (CORS) için aracı.
// Yalnızca uygulamanın adresinden gelen istekleri ve yalnızca api.notion.com/v1/ yolunu geçirir.
// Anahtar burada saklanmaz; uygulama her istekte kendi Notion anahtarını gönderir.
const ORIGIN = 'https://mertbrks.github.io';
const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname;
    if (req.headers.get('Origin') !== ORIGIN || !path.startsWith('/v1/')) return new Response('Yasak', { status: 403, headers: CORS });
    const r = await fetch('https://api.notion.com' + path, {
      method: req.method,
      headers: { Authorization: req.headers.get('Authorization'), 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: req.method === 'GET' ? undefined : await req.text(),
    });
    return new Response(r.body, { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  },
};
