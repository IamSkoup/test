// Offline Chromium smoke test. No requests to Supabase or other remote hosts.
// Test-only dependency: Playwright. The static website itself needs no Node.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const modules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const {chromium} = require(modules ? path.join(modules, 'playwright') : 'playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/kapani-main-classic.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    for (const [label, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
      const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
      await page.route('**/*', route => {
        if (/^https?:/i.test(route.request().url())) return route.abort('blockedbyclient');
        return route.continue();
      });
      await page.goto('about:blank');
      await page.addStyleTag({path:path.join(root,'assets/kapani-v8.css')});
      await page.addStyleTag({path:path.join(root,'assets/kapani-v10.css')});
      const syntax = await page.evaluate(code => {
        try { new Function(code); return null; } catch(e) { return e.message; }
      }, source);
      assert.equal(syntax, null, `${label}: browser JS parser rejected the entire main script: ${syntax}`);
      const cases = [
        ['casino', '<div id="kpV8Sheet" class="v8-overlay"><section class="v8-sheet"><header><h2>Баланс казино</h2></header><div class="v8-sheet-body"><button onclick="kpCasinoMove(&quot;deposit&quot;)">Пополнить</button></div></section></div>', '.v8-sheet'],
        ['gift', '<div id="giftSubModal" style="display:flex;position:fixed;inset:0"><div style="background:#170b10;width:100%;max-width:490px;padding:24px;">Подарить подписку</div></div>', '#giftSubModal > div'],
        ['passport', '<div id="passportModal" style="display:flex;position:fixed;inset:0"><div style="background:red;width:100%;max-width:420px;padding:24px;">Паспорт</div></div>', '#passportModal > div'],
        ['profile customizer', '<div id="profileCustomizerModal"><div style="position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:center"><div class="kapani-customizer-sheet" style="width:100%;max-width:490px;padding:24px;">Оформление</div></div></div>', '.kapani-customizer-sheet'],
      ];
      for (const [name, markup, panel] of cases) {
        const result = await page.evaluate(({markup,panel}) => {
          document.body.innerHTML=markup;
          const element=document.querySelector(panel);
          const box=element.getBoundingClientRect();
          const handler=document.querySelector('[onclick]')?.getAttribute('onclick');
          let handlerValid=true;
          try { if(handler)new Function(handler); } catch {handlerValid=false;}
          return {x:box.x,y:box.y,w:box.width,h:box.height,cx:box.x+box.width/2,cy:box.y+box.height/2,handlerValid};
        }, {markup,panel});
        assert.ok(result.handlerValid, `${label} ${name}: invalid inline click handler`);
        assert.ok(Math.abs(result.cx-width/2)<=3, `${label} ${name}: dialog shifted horizontally ${JSON.stringify(result)}`);
        assert.ok(Math.abs(result.cy-height/2)<=3, `${label} ${name}: dialog shifted vertically ${JSON.stringify(result)}`);
      }
      console.log(`${label}: browser parsed main script and centered casino, gift, passport and profile dialogs`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
