// ボイスメモ要約 - Service Worker
// キャッシュ戦略: 画面本体(HTML)はネットワーク優先、アイコン等はキャッシュ優先

const CACHE_NAME = 'voicememo-ai-v18'; // 画面（index.html）を変えたら番号を上げる（利用者に「新しいバージョンがあります」が出る）

// 画面本体を取りに行って、この時間を過ぎたら保存済みの画面を出す
const PAGE_TIMEOUT_MS = 4000;

// キャッシュするアセット
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ─── インストール：アセットを事前キャッシュ ───
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── アクティベート：古いキャッシュを削除 ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── フェッチ ───
self.addEventListener('fetch', event => {
  // GAS API リクエストは一切介入しない（SWを完全バイパス）
  // 理由：GASは302リダイレクトを返すため、SW経由での転送は
  //       大きなPOSTリクエストで失敗することがある
  if (event.request.url.includes('script.google.com') ||
      event.request.url.includes('googleusercontent.com')) {
    return; // respondWithを呼ばない = ブラウザのネイティブfetchに完全に任せる
  }

  // 画面本体はネットワーク優先（取れなければ保存済みの画面）。以前はすべて
  // キャッシュ優先だったため、sw.js自体を変えない限り新しい画面が端末に
  // 一切届かず、更新しても古い画面が表示され続けていた。
  // ただし電波が弱く、つながってはいるが遅いときに白い画面のまま待たせないよう、
  // 保存済みの画面があれば PAGE_TIMEOUT_MS で見切ってそれを出す（取りに行った最新の画面は
  // 裏で保存し、次に開いたときに使う）。fetch 自体は中断しない。
  const isPage = event.request.mode === 'navigate' || event.request.url.endsWith('/index.html');
  if (isPage) {
    const network = fetch(event.request.url, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          return caches.open(CACHE_NAME)
            .then(cache => cache.put('./index.html', clone))
            .then(() => response, () => response);
        }
        return response;
      });
    event.waitUntil(network.catch(() => {}));
    event.respondWith(
      caches.match('./index.html').then(cached => {
        if (!cached) return network;
        return Promise.race([
          // 画面が取れなかった（エラーの応答も含む）ときは保存済みの画面
          network.then(r => r.ok ? r : cached, () => cached),
          new Promise(resolve => setTimeout(() => resolve(cached), PAGE_TIMEOUT_MS))
        ]);
      })
    );
    return;
  }

  // アイコン・manifest等：キャッシュ優先 → ネットワーク
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        // キャッシュにない場合はネットワークから取得してキャッシュ
        return fetch(event.request)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('./index.html')); // オフライン時はindex.htmlを返す
      })
  );
});
