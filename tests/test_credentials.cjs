/** Check native credential replacement without touching a Zotero profile or secrets. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
// Evaluate the production controller; only login-manager operations are exercised.
const source = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');

/** Supply isolated native-login records and optional persistence failures. */
function fixture() {
  const records = [login('DeepSeek', 'old-deepseek'), login('OpenAI-compatible', 'old-compatible')];
  const calls = { removed: 0, modified: 0, added: 0, failModify: false, failAdd: false };
  const manager = {
    /** Read only records owned by this plugin and the requested realm. */
    findLogins(host, unused, realm) { return records.filter(value => value.hostname === host && value.httpRealm === realm); },
    /** Simulate an atomic native replacement rather than delete-and-add. */
    modifyLogin(old, changed) {
      if (calls.failModify) throw new Error('synthetic persistence failure');
      Object.assign(old, changed);
      calls.modified++;
    },
    /** Remove a credential only when the caller explicitly clears it. */
    removeLogin(value) { records.splice(records.indexOf(value), 1); calls.removed++; },
    /** Keep a failed first write from changing other existing profile credentials. */
    async addLoginAsync(value) {
      if (calls.failAdd) throw new Error('synthetic first-write failure');
      records.push(value);
      calls.added++;
    },
  };
  const context = { Services: { logins: manager }, Zotero: {}, Ci: { nsILoginInfo: {} },
    Cc: { '@mozilla.org/login-manager/loginInfo;1': { createInstance: () => login('', '') } } };
  vm.runInNewContext(source, context);
  return { bridge: context.PaperBridge, calls, records };
}

/** Model the public nsILoginInfo clone and initialization contract. */
function login(realm, password) {
  return { hostname: 'chrome://paperbridge', httpRealm: realm, username: 'api-key', password, guid: realm,
    /** Preserve the native metadata while editing a detached copy. */
    clone() { return { ...this }; },
    /** Initialize a new profile credential without changing an existing record. */
    init(host, unused, name, user, value) { Object.assign(this, { hostname: host, httpRealm: name, username: user, password: value }); },
  };
}

test('replacement preserves login identity and the other profile without deletion', async () => {
  const { bridge, calls, records } = fixture();
  await bridge.saveKey('new-value', 'deepseek');
  assert.equal(bridge.getKey('deepseek'), 'new-value');
  assert.equal(bridge.getKey('compatible'), 'old-compatible');
  assert.equal(records[0].guid, 'DeepSeek');
  assert.equal(calls.modified, 1);
  assert.equal(calls.removed, 0);
  assert.equal(calls.added, 0);
});

test('failed replacement and first write preserve all prior credentials', async () => {
  const { bridge, calls, records } = fixture();
  calls.failModify = true;
  await assert.rejects(bridge.saveKey('new-value', 'deepseek'), /persistence failure/);
  assert.equal(bridge.getKey('deepseek'), 'old-deepseek');
  assert.equal(bridge.getKey('compatible'), 'old-compatible');
  assert.equal(calls.removed, 0);
  records.splice(0, 1);
  calls.failAdd = true;
  await assert.rejects(bridge.saveKey('first-value', 'deepseek'), /first-write failure/);
  assert.equal(bridge.getKey('deepseek'), '');
  assert.equal(bridge.getKey('compatible'), 'old-compatible');
});

test('explicit clearing removes only the selected profile credential', async () => {
  const { bridge, calls } = fixture();
  await bridge.saveKey('', 'compatible');
  assert.equal(bridge.getKey('compatible'), '');
  assert.equal(bridge.getKey('deepseek'), 'old-deepseek');
  assert.equal(calls.removed, 1);
});
