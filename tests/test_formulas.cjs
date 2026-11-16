const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let clipboard = 'unchanged';
let requests = 0;
const context = vm.createContext({
  Cc: { '@mozilla.org/widget/clipboardhelper;1': { getService: () => ({ copyString: v => { clipboard = v; } }) } },
  Ci: { nsIClipboardHelper: {} }
});
vm.runInContext(fs.readFileSync('addon/content/formulas.js', 'utf8'), context);
const values = new Map();
const formulas = new context.FormulaClipboard({
  alive:true,
  formulaCache:{context:async reader=>({id:reader.itemID}),key:value=>JSON.stringify(value),lookup:async(ctx,key)=>values.get(ctx.id+key),store:async(ctx,key,selection,latex)=>values.set(ctx.id+key,latex)},
  getKey: () => 'fixture', pref: () => 'https://api.deepseek.com',
  request: async () => { requests++; return { latex: '\\frac{x^2}{y_i}' }; }
});
(async () => {
  const reader = { itemID: 1 };
  const selection = { text: 'x2/yi', glyphs: [] };
  assert.equal(await formulas.copy(reader, selection, false), '$\\frac{x^2}{y_i}$');
  assert.equal(await formulas.copy(reader, selection, true), '$$\\frac{x^2}{y_i}$$');
  assert.equal(requests, 1);
  await formulas.copy(reader, null, false, '\\[x^2\\]');
  assert.equal(clipboard, '$x^2$');
  assert.equal(requests, 1);
  formulas.bridge.request = async () => { throw Error('provider failed'); };
  await assert.rejects(() => formulas.copy({ itemID: 2 }, selection, false));
  assert.equal(clipboard, '$x^2$');
  const glyph = { c: '2', rect: [1, 2, 3, 4] };
  reader._internalReader = { _primaryView: { _pdfPages: [{ chars: [glyph, { c: 'outside', rect: [50, 50, 51, 51] }] }] } };
  const payload = formulas.selection(reader, { text: 'x2', position: { pageIndex: 0, rects: [[0, 0, 4, 5]] } });
  assert.equal(payload.glyphs.length, 1);
  assert.equal(payload.glyphs[0].c, '2');
  console.log('Formula delimiters, native LaTeX, cache, geometry and clipboard failure safety passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
