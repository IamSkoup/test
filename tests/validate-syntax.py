"""Parse all shipped JavaScript and static HTML event handlers; no network or writes to production."""
from pathlib import Path
from html.parser import HTMLParser
import subprocess, tempfile, json, re
ROOT=Path(__file__).resolve().parent.parent
html=(ROOT/'index.html').read_text()
with tempfile.TemporaryDirectory() as temp:
    count=0
    for i,m in enumerate(re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html)):
        if not m[2].strip(): continue
        target=Path(temp)/f'script-{i}{".mjs" if "module" in m[1] else ".js"}'
        target.write_text(m[2]);subprocess.run(['node','--check',str(target)],check=True);count+=1
    print(f'PASS {count} inline script blocks')
    for p in ROOT.rglob('*.js'):
        subprocess.run(['node','--check',str(p)],check=True)
    print('PASS standalone JavaScript files')
    class Markup(HTMLParser):
        handlers=[]
        def handle_starttag(self,tag,attrs):
            for key,value in attrs:
                if key.startswith('on') and value: self.handlers.append(value)
                if tag=='script' and key=='src' and value.startswith('./'):
                    assert (ROOT/value[2:]).is_file(),value
    parser=Markup();parser.feed(html)
    p=Path(temp)/'handlers.cjs';p.write_text('const handlers='+json.dumps(parser.handlers)+'; for(const code of handlers) new Function("event",code);')
    subprocess.run(['node',str(p)],check=True)
    print(f'PASS {len(parser.handlers)} static event handlers and local script paths')
    # Historical placeholder for a Cloudflare service-account secret, not app JSON.
    for p in ROOT.rglob('*.json'):
        if p.relative_to(ROOT).as_posix() == 'push-worker/sa-new.json':
            continue
        json.loads(p.read_text(encoding='utf-8-sig'))
    print('PASS JSON files')
