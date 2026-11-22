// Guarda os arquivos do app no celular para ele abrir sem internet.
// Ao mudar qualquer arquivo do app, aumentar a versão abaixo.
const VERSAO = 'obras-vm-v1';
const ARQUIVOS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'img/logo-vm-clara.png',
  'img/icone-192.png',
  'img/icone-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Responde com a cópia guardada e, se houver internet, atualiza a cópia por trás.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(VERSAO).then(async (cache) => {
      const guardado = await cache.match(e.request, { ignoreSearch: true });
      const daRede = fetch(e.request)
        .then((r) => { if (r && r.ok) cache.put(e.request, r.clone()); return r; })
        .catch(() => guardado);
      return guardado || daRede;
    })
  );
});
