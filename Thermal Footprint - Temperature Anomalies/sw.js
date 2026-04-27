/**
 * sw.js — Service Worker : The Infected Globe
 * ─────────────────────────────────────────────
 * Stratégies de cache :
 *
 *   metadata.json          → Network-first.
 *                            Compare total_bytes avec la version cachée.
 *                            Si différent → invalide thermal_anomalies.bin
 *                            (running prepare_thermal_data.py bust le cache auto).
 *
 *   thermal_anomalies.bin  → Cache-first.
 *                            ~27 Mo mis en cache au 1er chargement.
 *                            Chargement instantané les fois suivantes.
 *
 *   Tout le reste          → Cache-first + fallback réseau.
 *   (HTML, JS, textures,     Mis en cache à la première visite.
 *    CDN Three.js)
 *
 * Pour incrémenter la version du cache manuellement (purge complète) :
 *   Changer CACHE_NAME ci-dessous.
 */

const CACHE_NAME         = 'infected-globe-v1';
const THERMAL_BIN_PATH   = '/thermal_anomalies.bin';
const METADATA_PATH      = '/metadata.json';


// ─── Install ─────────────────────────────────────────────────────────────────
// Activation immédiate — pas de pré-cache forcé, tout est mis en cache à la demande.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});


// ─── Activate ────────────────────────────────────────────────────────────────
// Supprime les anciens caches et prend le contrôle immédiatement.

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Cache obsolète supprimé :', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
  );
});


// ─── Fetch ───────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  // Ignorer les requêtes non-GET
  if (event.request.method !== 'GET') return;

  const pathname = new URL(event.request.url).pathname;

  if (pathname.endsWith('metadata.json')) {
    event.respondWith(handleMetadata(event.request));
    return;
  }

  if (pathname.endsWith('thermal_anomalies.bin')) {
    event.respondWith(handleThermalBin(event.request));
    return;
  }

  event.respondWith(handleStatic(event.request));
});


// ─── Stratégie : metadata.json ───────────────────────────────────────────────
// Network-first. Compare total_bytes pour détecter une régénération du .bin.

async function handleMetadata(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await fetch(request);

    // Trois clones : un pour cache, un pour retour, un pour lecture JSON
    const forCache  = networkResponse.clone();
    const forReturn = networkResponse.clone();
    const freshMeta = await networkResponse.json();

    // Comparer avec la version en cache
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      try {
        const cachedMeta = await cachedResponse.json();
        if (cachedMeta.total_bytes !== freshMeta.total_bytes) {
          console.log(
            `[SW] metadata.json modifié (${cachedMeta.total_bytes} → ${freshMeta.total_bytes} octets).` +
            ' Invalidation du cache .bin...'
          );
          await invalidateThermalBin(cache);
        }
      } catch (_) {
        // metadata cachée illisible — invalide le .bin par précaution
        await invalidateThermalBin(cache);
      }
    }

    await cache.put(request, forCache);
    return forReturn;

  } catch (_) {
    // Hors ligne ou erreur réseau — servir depuis le cache
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW] metadata.json servi depuis le cache (offline)');
      return cached;
    }
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}


// ─── Stratégie : thermal_anomalies.bin ───────────────────────────────────────
// Cache-first. Mise en cache silencieuse au premier chargement (~27 Mo).

async function handleThermalBin(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    console.log('[SW] thermal_anomalies.bin → cache (chargement instantané)');
    return cached;
  }

  console.log('[SW] thermal_anomalies.bin → réseau (première visite, mise en cache...)');
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      // Mise en cache non-bloquante — la réponse est retournée immédiatement
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_) {
    return new Response('Service unavailable', { status: 503 });
  }
}


// ─── Stratégie : assets statiques ────────────────────────────────────────────
// Cache-first. Mis en cache à la première visite, servis instantanément ensuite.
// Couvre : infecte.html, infecte_main.js, infecte_shaders.js, textures, CDN.

async function handleStatic(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_) {
    // Pas en cache + hors ligne
    return new Response('Offline', { status: 503 });
  }
}


// ─── Utilitaire : invalidation du .bin ───────────────────────────────────────
// Cherche dans le cache toute entrée dont le pathname est /thermal_anomalies.bin
// (évite les problèmes d'URL absolue vs relative).

async function invalidateThermalBin(cache) {
  const keys = await cache.keys();
  for (const key of keys) {
    if (new URL(key.url).pathname === THERMAL_BIN_PATH) {
      await cache.delete(key);
      console.log('[SW] thermal_anomalies.bin supprimé du cache');
    }
  }
}
