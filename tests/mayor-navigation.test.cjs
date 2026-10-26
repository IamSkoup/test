const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const navSource = html.match(/window\.navTo=function\(id\)\{[\s\S]*?\n\};/)?.[0];
assert.ok(navSource, 'main navigation function must exist');

function makeNavigation(nick) {
  const events = [];
  const sections = ['home', 'adminPage'].map(id => ({
    id,
    classList: {
      active: id === 'home',
      remove(name) { if (name === 'active') this.active = false; },
      add(name) { if (name === 'active') this.active = true; }
    },
    style: {},
    offsetHeight: 1
  }));
  const byId = Object.fromEntries(sections.map(section => [section.id, section]));
  const context = {
    currentNick: nick, ADMIN: 'Кайон', curPage: 'home', bnMap: {},
    document: {querySelectorAll: () => sections},
    qs: id => byId[id] || null,
    toast: () => events.push('denied'),
    leaveService: () => {}, detachLivePage: () => {},
    unlockBodyScroll: () => {}, requestAnimationFrame: fn => fn(),
    enterService: () => {}, attachLivePage: () => {},
    renderAdmin: () => events.push('render'),
    renderAdminAdvertiserStats: () => {},
    setTimeout: () => {},
    console
  };
  context.window = context;
  context.window.scrollTo = () => {};
  context.window.mountMayorDashboard = () => events.push('mount');
  vm.runInNewContext(navSource, context);
  return {context, events, byId};
}

test('resident cannot open mayor page through navigation', () => {
  const {context, events, byId} = makeNavigation('Житель');
  context.navTo('adminPage');
  assert.deepEqual(events, ['denied']);
  assert.equal(byId.adminPage.classList.active, false);
});

test('mayor opens dashboard without an extra session gate', () => {
  const {context, events, byId} = makeNavigation('Кайон');
  context.navTo('adminPage');
  assert.equal(byId.adminPage.classList.active, true);
  assert.deepEqual(events, ['mount', 'render']);
});
