# Kapani chat/realtime fix

- General chat stays on one RTDB `onValue(query(chat, orderByChild(createdAt), limitToLast(80)))` listener while the Messages section is open.
- Typing indicator remains on the single `typing/chat` listener and is rendered without page reloads.
- General-chat notification fan-out moved from the client to Firebase Cloud Function `notifyOnChatMessage` on `chat/{messageId}` to avoid N×client writes and duplicate notifications.
- Notification URL is canonical `/kapani/`; Cloudflare Worker and Service Worker normalize legacy `/index.html` URLs to `/kapani/`.
- Firebase Messaging Service Worker is now valid JavaScript (no Markdown fences).

Deploy/update the Firebase Functions and Cloudflare Worker after uploading the archive.
