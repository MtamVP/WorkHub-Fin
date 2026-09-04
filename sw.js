const CACHE_NAME = 'workhub-fin-cache-v1.0.0';

self.addEventListener('install', event => {
    self.skipWaiting();
    console.log('[PWA] Service Worker đã cài đặt');
});

self.addEventListener('activate', event => {
    // clients.claim() trước đây gọi RỜI ngoài waitUntil() -- 'activate' có thể được coi là
    // xong ngay khi promise xoá cache cũ resolve, còn clients.claim() chạy tự do không ai
    // đợi, nên 1 service worker mới có thể chưa kịp giành quyền kiểm soát các tab đang mở.
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => {
                if (key !== CACHE_NAME) {
                    console.log('[PWA] Xóa cache cũ:', key);
                    return caches.delete(key);
                }
            })
        )).then(() => self.clients.claim())
    );
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
                    // cache.put() ném lỗi với request không phải GET (vd. 1 <form method="post">
                    // điều hướng cả trang) -- trước đây gọi thẳng không kiểm tra, tạo unhandled
                    // promise rejection mỗi lần có navigate POST.
                    if (event.request.method === 'GET') {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then(cachedRes => {
                    // Trước đây nếu cache cũng không có đúng request này (vd. sau khi đổi
                    // CACHE_NAME, hoặc 1 deep link chưa từng được cache), respondWith() nhận
                    // undefined -> ném lỗi "Failed to convert value to Response", trình duyệt
                    // hiện màn hình lỗi mạng thô thay vì có gì đó offline. Rơi tiếp về trang
                    // gốc đã cache (SPA, route nào cũng render được) rồi mới tới thông báo lỗi.
                    if (cachedRes) return cachedRes;
                    return caches.match('/index.html').then(fallback => fallback ||
                        new Response('Không có mạng và chưa có bản lưu ngoại tuyến cho trang này.',
                            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
                }))
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
