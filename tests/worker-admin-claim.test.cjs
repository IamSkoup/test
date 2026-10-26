const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, generateKeyPairSync, verify } = require('node:crypto');

test('Worker issues an admin claim only for the configured mayor UID', async () => {
  const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const env = {
    ADMIN_NICK:'Кайон',
    FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({
      type:'service_account', client_email:'example@example.iam.gserviceaccount.com',
      private_key:privateKey.export({type:'pkcs8',format:'pem'}).toString(),private_key_id:'test-key'
    })
  };
  for (const filename of ['worker.js','worker-bundled.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../push-worker', filename), 'utf8')
      .replace(/^import[^\n]*\n/, '')
      .replace('export default {', 'globalThis.worker = {');
    const context = vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,console,URL,Response,Headers,Request,fetch,atob,btoa});
    vm.runInContext(source, context);
    for (const [uid,expected] of [['Кайон',true],['Житель',false]]) {
      const token = await context.createFirebaseCustomToken(env,uid);
      const [header,payload,signature] = token.split('.');
      assert.equal(verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),publicKey,Buffer.from(signature,'base64url')),true);
      const claims = JSON.parse(Buffer.from(payload,'base64url').toString());
      assert.equal(claims.uid,uid);
      assert.equal(claims.claims.admin,expected);
    }
    delete env.ADMIN_NICK;
    const withoutConfig = await context.createFirebaseCustomToken(env,'Кайон');
    assert.equal(JSON.parse(Buffer.from(withoutConfig.split('.')[1],'base64url').toString()).claims.admin,false);
    env.ADMIN_NICK = 'Кайон';
  }
});
