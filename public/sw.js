const C="erlc-v4";
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(["/app","/manifest.webmanifest"])));self.skipWaiting()});
self.addEventListener("activate",e=>e.waitUntil(clients.claim()));
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(u.pathname.startsWith("/api/")||e.request.method!=="GET")return;
 e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
