import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('./worker.js',import.meta.url),'utf8');
const catalogue=await readFile(new URL('../functions/subscription-config.js',import.meta.url),'utf8');
await writeFile(new URL('./worker-bundled.js',import.meta.url),'// Generated from worker.js and the shared catalogue. Rebuild with node build-dashboard.mjs.\n'+catalogue+'\n'+source.replace(/^import '\.\.\/functions\/subscription-config\.js';\n/,''));
