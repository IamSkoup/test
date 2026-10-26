// Единый источник конфигурации Kapani.
// Используется приложением и Service Worker через importScripts().
const KAPANI_CONFIG = Object.freeze({
    supabase: {
        url: "https://npivvwwkdnbeqmjcwrke.supabase.co",
        // Public/browser key. Never put service_role or sb_secret_* here.
        anonKey: "sb_publishable_1JhKuvlyy43Zehyr4Z-JZg_AIfMiAts"
    },
    // A new VAPID key pair must be configured together in Edge Function secrets.
    webPushVapidPublicKey: "BC2-KpOURTy2hZwC6pVNSgu6zbFVohUWuPnK8SOY5-xBupWzspvbhoMaSbp-ya3xB5CZ5IHONm5PQeWSKLyfm8E",
    pushWorkerUrl: "https://npivvwwkdnbeqmjcwrke.supabase.co/functions/v1/kapani-push",
    admin: { username: "Денис" },
    jobs: { janitor: "Уборщик", janitorTaskText: "Убрать площадку" },
    finance: { minBalanceAllowed: -2500, pricePerKm: 250, maxSpeedKmh: 30 },
    location: { kapani: { lat: 52.628825753234985, lng: 38.416863347119566 } },
    rewards: { customAvatar: 40, firstWall: 60 },
    subscriptions: {
        plus: { price: 299, name: "Kapani Plus" },
        ultra: { price: 899, name: "Kapani Ultra" },
        prime: { price: 1499, name: "Kapani Prime" }
    },
    limits: { chatMessages: 60, dmMessages: 80, videoCircleMaxDuration: 30, debounceTimeout: 50 },
    ui: { defaultAvatarUrl: "https://cdn-icons-png.flaticon.com/512/149/149071.png" }
});
globalThis.KAPANI_CONFIG = KAPANI_CONFIG;
