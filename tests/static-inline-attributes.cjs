// Compile every real inline HTML handler in index.html, excluding JavaScript
// template text inside <script>. The HTML parser decodes entities as a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const htmlPath = path.join(__dirname, '..', 'index.html');
const parser = `from html.parser import HTMLParser
import sys,json
class P(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True)
  self.a=[]
  self.scripts=[]
  self.collect=False
  self.script=[]
 def handle_starttag(self,tag,attrs):
  if tag=='script' and not any(n=='src' for n,v in attrs):
   self.collect=True
   self.script=[]
  for name,value in attrs:
   if name and name.lower().startswith('on') and value is not None:
    self.a.append([tag,name,value])
 def handle_data(self,data):
  if self.collect:self.script.append(data)
 def handle_endtag(self,tag):
  if tag=='script' and self.collect:
   self.scripts.append(''.join(self.script))
   self.collect=False
p=P();p.feed(open(sys.argv[1],encoding='utf-8').read());print(json.dumps({'handlers':p.a,'scripts':p.scripts},ensure_ascii=False))`;
const processResult = spawnSync('python3', ['-c',parser,htmlPath], {encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
assert.equal(processResult.status,0,processResult.stderr);
const {handlers,scripts} = JSON.parse(processResult.stdout);
const errors = [];
for (const [tag,attr,code] of handlers) {
  try { new vm.Script(`(async function(event){${code}\n})`,{filename:`<${tag} ${attr}>`}); }
  catch(e){errors.push(`<${tag} ${attr}> ${JSON.stringify(code).slice(0,160)}: ${e.message}`);}
}
assert.deepEqual(errors,[],`Malformed static handlers:\n${errors.join('\n')}`);
scripts.forEach((source,index) => new vm.Script(source,{filename:`index.html inline script ${index+1}`}));
console.log(`OK: ${handlers.length} HTML event handlers and ${scripts.length} inline scripts parsed as JavaScript.`);
