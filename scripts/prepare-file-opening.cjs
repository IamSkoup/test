#!/usr/bin/env node
'use strict';

// A one-time, mechanical conversion of the old inline module entry points to
// ordered, deferred classic scripts. Browsers can load these under file://,
// whereas same-folder ES module imports are CORS-blocked in Firefox/Chrome.
// The legacy ESM Supabase bridge stays intact for reference/test tooling.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const assetDir = path.join(root, 'assets');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, source) => fs.writeFileSync(path.join(root, file), source, 'utf8');

function convertBridge() {
  const original = read('supabase-bridge.js');
  const importLine = /^import \{ createClient \} from 'https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^']+\/\+esm';\s*$/m;
  if (!importLine.test(original)) throw new Error('The Supabase ESM entry has changed; inspect before rebuilding');
  const source = original.replace(importLine,
    "const createClient = window.supabase?.createClient;\nif (typeof createClient !== 'function') throw new Error('Supabase SDK could not be loaded');")
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|class)\b)/gm, '');
  if (/^export\s/m.test(source)) throw new Error('Unexpected bridge export syntax');
  const names = [
    'supabase','db','ref','set','get','update','push','remove','onValue','off',
    'serverTimestamp','runTransaction','query','orderByChild','equalTo',
    'limitToLast','onDisconnect','authEmail','patchOwnProfile',
    'manageOwnNotifications','claimVerifiedTask','withdrawVerifiedTasks'
  ];
  write('assets/supabase-bridge-classic.js',
    `/* Generated from supabase-bridge.js for file:// and HTTPS script loading. */\n`+
    `(function(){\n'use strict';\ntry {\n${source}\n`+
    `window.KAPANI_BRIDGE = {${names.join(',')}};\n`+
    `} catch (error) { console.error('[Kapani bridge]',error); window.kapaniShowBootError?.('Не удалось подключить Supabase',error?.message); }\n})();\n`);
}

function convertEntries() {
  let html = fs.readFileSync(indexPath, 'utf8');
  const originalModules = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  if (originalModules.length === 0 && html.includes('./assets/kapani-main-classic.js')) {
    console.log('Classic entry points already present; refreshing bridge and seasonal script');
    return;
  }
  if (originalModules.length !== 2) throw new Error(`Expected exactly 2 inline ES modules; got ${originalModules.length}`);

  let main = originalModules[0][1];
  const mainImport = /^import \{\s*supabase, db, ref, set, get, update, push, remove, onValue, off,[\s\S]*?claimVerifiedTask, withdrawVerifiedTasks \} from '\.\/supabase-bridge\.js';/m;
  const imported = main.match(mainImport);
  if (!imported) throw new Error('Cannot find the main Supabase bridge import');
  main = main.replace(mainImport, imported[0].replace(/^import/, 'const').replace(/from '\.\/supabase-bridge\.js';$/, '= window.KAPANI_BRIDGE;'));
  main = main.replace(/(= window\.KAPANI_BRIDGE;)/,
    "= window.KAPANI_BRIDGE || {};\nif (!supabase) throw new Error('Защищённый клиент Supabase не загружен');");
  write('assets/kapani-main-classic.js',
    `/* Kapani main entry. Runs once after the HTML has been parsed. */\n`+
    `(async function(){\n'use strict';\n${main}\n})().catch(error=>{console.error('[Kapani bootstrap]',error);window.kapaniShowBootError?.('Ошибка запуска сайта',error?.message);});\n`);
  write('assets/kapani-pack-classic.js',
    `/* Kapani Pack v2 — no file:// module fetches. */\n`+
    `(function(){\n'use strict';\n${originalModules[1][1]}\n})();\n`);

  // Keep the exact location of each module in the document; the deferred
  // classic entries run after parsing and in document order, like modules.
  html = html.replace(originalModules[0][0],'<script src="./assets/kapani-main-classic.js" defer></script>');
  html = html.replace(originalModules[1][0],'<script src="./assets/kapani-pack-classic.js" defer></script>');
  html = html.replace('<script type="module" src="./assets/kapani-season.js"></script>',
    '<script src="./assets/kapani-season-classic.js" defer></script>');
  const sdk = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.8" defer></script>\n`+
    `<script src="./assets/supabase-bridge-classic.js" defer></script>\n`;
  html = html.replace('<script src="./assets/kapani-main-classic.js" defer></script>',
    sdk+'<script src="./assets/kapani-main-classic.js" defer></script>');
  write('index.html', html);
}

function convertSeason() {
  const source=read('assets/kapani-season.js');
  write('assets/kapani-season-classic.js',
    `/* Kapani season: classic script for file:// and HTTPS. */\n`+
    `(function(){\n'use strict';\n${source}\n})();\n`);
}

fs.mkdirSync(assetDir, {recursive:true});
convertBridge();
convertEntries();
convertSeason();
console.log('Kapani file-compatible scripts prepared');
