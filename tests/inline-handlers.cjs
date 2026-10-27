// The browser compiles inline onclick attributes at click time. Checking the
// main JS file alone misses broken HTML quoting inside generated buttons.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/kapani-main-classic.js'), 'utf8');
const functionSource = source.match(/function button\(label,click,cls='btn btn-primary'\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(functionSource, 'Missing generated button helper');
const escape = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const button = new Function('html', `return (${functionSource})`)(escape);
const decode = s => s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<')
  .replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const cases = [
  ['casino deposit', 'kpCasinoMove("deposit")'],
  ['casino withdraw', 'kpCasinoMove("withdraw")'],
  ['news reaction', "kpReact('news','reply-12','❤')"],
  ['market listing', "kpDeliveryForListing('abc_123')"],
  ['hospital appointment', 'kpCloseSheet()'],
  ['business receipt', "confirmBizOrderReceipt('biz_1','order_12')"],
];
for (const [name, expression] of cases) {
  const markup = button('Пополнить', expression);
  const match = markup.match(/\sonclick="([^"]*)"/);
  assert.ok(match, `${name} missing quoted handler`);
  const handler = decode(match[1]);
  assert.equal(handler, expression, `${name} truncated or changed the handler`);
  new vm.Script(handler, {filename:`onclick/${name}`});
}
console.log(`OK: ${cases.length} generated onclick handlers survived HTML encoding and JavaScript parsing.`);
