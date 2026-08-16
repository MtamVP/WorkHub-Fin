const CACHE_NAME = 'workhub-fin-cache-v1.0.0';

self.addEventListener('install', event => {
    self.skipWaiting();
    console.log('[PWA] Service Worker đã cài đặt');
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if (key !== CACHE_NAME) {
                    console.log('[PWA] Xóa cache cũ:', key);
                    return caches.delete(key);
                }
            })
        ))
    );
    return self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = event.request.url;

    if (url.includes('script.google.com') || url.includes('script.googleusercontent.com') || url.includes('supabase.co')) {
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    if (['image', 'font'].includes(event.request.destination)) {
        event.respondWith(
            caches.match(event.request).then(cachedRes => {
                if (cachedRes) return cachedRes;
                return fetch(event.request).then(networkRes => {
                    if (!networkRes || networkRes.status !== 200 || networkRes.type !== 'basic') {
                        return networkRes;
                    }
                    const responseClone = networkRes.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                    return networkRes;
                });
            })
        );
        return;
    }

    if (['style', 'script'].includes(event.request.destination)) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }
});
