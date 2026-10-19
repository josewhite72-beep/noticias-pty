/* ============================================
   SERVICE WORKER — Noticias_pty
   - App (HTML/CSS/JS/íconos): stale-while-revalidate
     → carga instantánea desde caché y se actualiza sola en segundo plano.
   - Noticias (Worker o JSON de ejemplo): network-first
     → siempre lo más nuevo; si no hay señal, lo último guardado.
   - Imágenes: cache-first con límite de entradas
     → las fotos ya vistas se leen sin conexión.
   ============================================ */

const VERSION = 'v5';
const CACHE_APP = `noticias-pty-app-${VERSION}`;
const CACHE_DATOS = `noticias-pty-datos-${VERSION}`;
const CACHE_IMG = `noticias-pty-img-${VERSION}`;
const MAX_IMAGENES = 80;

// Rutas relativas a la ubicación del SW (funciona en raíz o en subcarpeta)
const ARCHIVOS_APP = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

// INSTALL: precachea la app y una copia inicial de las noticias
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cacheApp = await caches.open(CACHE_APP);
    await cacheApp.addAll(ARCHIVOS_APP);
    try {
      const cacheDatos = await caches.open(CACHE_DATOS);
      await cacheDatos.add('./noticias.json');
    } catch (e) {
      // Si falla, no bloquea la instalación
    }
    await self.skipWaiting();
  })());
});

// ACTIVATE: borra cachés de versiones anteriores y toma control de inmediato
self.addEventListener('activate', (event) => {
  const vigentes = [CACHE_APP, CACHE_DATOS, CACHE_IMG];
  event.waitUntil((async () => {
    const nombres = await caches.keys();
    await Promise.all(nombres
      .filter(n => n.startsWith('noticias-pty') && !vigentes.includes(n))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// FETCH: enruta cada petición a su estrategia
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Búsquedas: siempre a la red (cada texto es distinto; no se guardan)
  if (url.pathname.endsWith('/buscar')) return;

  // Noticias: peticiones fetch() de la app (Worker o noticias.json de ejemplo)
  if (req.destination === '' && !url.pathname.endsWith('manifest.json')) {
    event.respondWith(redPrimero(req, CACHE_DATOS));
    return;
  }

  // Imágenes (incluidas las de otros dominios)
  if (req.destination === 'image') {
    event.respondWith(cachePrimeroImagen(req));
    return;
  }

  // Navegación y archivos de la propia app
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

// --- Estrategias ---

async function redPrimero(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  try {
    const resp = await fetch(req, { cache: 'no-cache' });
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    const guardada = await cache.match(req, { ignoreSearch: true });
    if (guardada) return guardada;
    throw e;
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE_APP);
  const esNavegacion = req.mode === 'navigate';
  const guardada = await cache.match(req, { ignoreSearch: esNavegacion })
    || (esNavegacion ? await cache.match('./index.html') : undefined);

  const red = fetch(req)
    .then(resp => {
      if (resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    })
    .catch(() => undefined);

  if (guardada) {
    event.waitUntil(red); // actualiza en segundo plano
    return guardada;
  }
  const resp = await red;
  return resp || new Response('Sin conexión', { status: 503, statusText: 'Offline' });
}

async function cachePrimeroImagen(req) {
  const cache = await caches.open(CACHE_IMG);
  const guardada = await cache.match(req);
  if (guardada) return guardada;
  try {
    const resp = await fetch(req);
    // Las imágenes de otros dominios llegan "opaque" (status 0); también se guardan
    if (resp.ok || resp.type === 'opaque') {
      await cache.put(req, resp.clone());
      recortarCache(CACHE_IMG, MAX_IMAGENES);
    }
    return resp;
  } catch (e) {
    // Sin red y sin copia: la app muestra el bloque de categoría
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function recortarCache(nombre, max) {
  const cache = await caches.open(nombre);
  const claves = await cache.keys();
  for (let i = 0; i < claves.length - max; i++) {
    await cache.delete(claves[i]);
  }
}
