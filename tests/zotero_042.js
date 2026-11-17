/** Historical macOS 0.4.2 checks; loaded only by its disposable test add-on. */
/** Exercise fixture-based copying and cache ownership without changing release code. */
var runFormula042Tests = async (bridge, state, source, translated, root, check) => {
  /** Wait between native frame updates. */
  const pause = ms => Zotero.Promise.delay(ms);
  /** Bound native readiness without treating a completed script as a passing check. */
  const until = async predicate => {
    for (let i = 0; i < 120; i++) {
      if (await predicate()) return;
      await pause(100);
    }
    throw Error('Timed out waiting for formula test; provider calls='+bridge._formulaTestCalls+' clipboard='+clipboard());
  };
  /** Read the actual system clipboard. */
  const clipboard = () => Zotero.Utilities.Internal.getClipboard('text/plain');
  const reader = state.translationReader;
  await reader.navigate({pageIndex:4});
  await pause(700);
  const originalRequest = bridge.request;
  const originalGetKey = bridge.getKey;
  let calls=0;bridge._formulaTestCalls=0;
  const expected = String.raw`A_t^{\tau+\delta}=A_t^\tau+\delta v_\theta(A_t^\tau,o_t)`;
  bridge.getKey=()=> 'isolated-formula-fixture';
  bridge.request=async function(path,method,data){if(path==='/formulas/latex'){calls++;bridge._formulaTestCalls=calls;return{latex:expected};}return originalRequest.call(this,path,method,data);};
  try {
    const initial=await bridge.formulaCache.context(reader);
    await bridge.formulaCache.clear(initial.id);
    await bridge.formulaCache.link(source,translated);
    const regions = await bridge.formulas.regions(reader,4);
    check('localDisplayFormulaDetection',regions.length>=2 && regions.every(r=>r.selection.glyphs.length));
    const view = state.right._primaryView, frame=view._iframeWindow, app=frame.PDFViewerApplication;
    await until(()=>app.pdfViewer.currentPageNumber===5 && app.pdfViewer.getPageView(4)?.div.isConnected);
    const page=app.pdfViewer.getPageView(4);
    const region=regions[0];
    const point=page.viewport.convertToViewportPoint((region.rect[0]+region.rect[2])/2,(region.rect[1]+region.rect[3])/2);
    const bounds=page.div.getBoundingClientRect();
    page.div.dispatchEvent(new frame.PointerEvent('pointermove',Components.utils.cloneInto({bubbles:true,clientX:bounds.left+point[0]*bounds.width/page.viewport.width,clientY:bounds.top+point[1]*bounds.height/page.viewport.height},frame)));
    const icon=frame.document.querySelector('.paperbridge-display-formula-copy');
    await until(()=>!icon.hidden);
    check('displayFormulaHoverIcon',icon.dataset.pageIndex==='4');
    check('hoverMakesNoProviderRequest',calls===0);
    icon.click();await until(()=>calls===1 && !icon.disabled && clipboard()==='$$'+expected+'$$');
    check('hoverCopiesDisplayLatex',calls===1);
    icon.click();await until(()=>!icon.disabled);check('repeatedHoverCopyCached',calls===1);
    const context=await bridge.formulaCache.context(reader);
    const jsonPath=PathUtils.join(bridge.formulaCache.root,context.id+'.json');
    const persisted=await IOUtils.readJSON(jsonPath);
    check('oneJsonForOriginalAndTranslation',persisted.references.some(r=>r.attachmentKeys.includes(source.key)&&r.attachmentKeys.includes(translated.key)));
    check('formulaAndRegionsPersisted',Object.keys(persisted.entries).length>0&&Object.keys(persisted.pages).length>0);
    const Cache=bridge.formulaCache.constructor;
    await bridge.formulaCache.settled();bridge.formulaCache=new Cache(bridge);await bridge.formulaCache.load();
    bridge.getKey=()=>'';
    await bridge.formulas.copy(reader,region.selection,false);
    check('restartCacheHitWithoutApiKey',calls===1 && clipboard()==='$'+expected+'$');
    bridge.getKey=()=> 'isolated-formula-fixture';
    const manager=bridge.showFormulaCache();
    await until(()=>manager.document.getElementById('documents')?.children.length>0);
    const button=[...manager.document.getElementById('documents').children].find(b=>b.dataset.id===context.id);button.click();
    check('cacheViewerShowsLatex',manager.document.getElementById('details').value.includes(expected));
    const pdfBefore=await IOUtils.stat(await translated.getFilePathAsync());
    const annotationsBefore=translated.getAnnotations().map(a=>a.key).sort().join(',');
    manager.document.getElementById('clear').click();await until(()=>!bridge.formulaCache.documents.has(context.id));
    check('manualClearOnlyFormulaCache',await translated.fileExists() && (await IOUtils.stat(await translated.getFilePathAsync())).size===pdfBefore.size && translated.getAnnotations().map(a=>a.key).sort().join(',')===annotationsBefore);
    manager.close();
    await bridge.formulas.copy(reader,region.selection,true);
    if(calls!==2)throw Error('manualClearForcesOneNewRequest: provider calls='+calls);
    check('manualClearForcesOneNewRequest',calls===2);
    // Real Zotero deletion notifications, separate paper owners and attachment keys.
    const makePaper=async title=>{const item=new Zotero.Item('journalArticle');item.setField('title',title);await item.saveTx();return item;};
    const a=await makePaper('Formula cache lifecycle A'),b=await makePaper('Formula cache lifecycle B');
    const fixture=root+'/.runtime/formula-cache-fixture.pdf';
    const attach=parent=>Zotero.Attachments.importFromFile({file:fixture,parentItemID:parent.id});
    const sa=await attach(a),ta=await attach(a),ta2=await attach(a),sb=await attach(b);
    await bridge.formulaCache.link(sa,ta);await bridge.formulaCache.link(sa,ta2);
    const ca=await bridge.formulaCache.context({itemID:sa.id});const sel={text:'q',glyphs:[]};
    await bridge.formulaCache.store(ca,bridge.formulaCache.key(sel),sel,'q');
    await bridge.formulaCache.context({itemID:sb.id});
    await sa.eraseTx();await bridge.library.settled();await bridge.formulaCache.reconcile();
    check('deletingOriginalKeepsFormulaCache',bridge.formulaCache.documents.has(ca.id));
    await ta.eraseTx();await bridge.library.settled();await bridge.formulaCache.reconcile();
    check('deletingOneTranslationKeepsOtherReferences',bridge.formulaCache.documents.has(ca.id)&&await ta2.fileExists());
    a.deleted=true;await a.saveTx();await bridge.library.settled();await bridge.formulaCache.reconcile();
    check('deletingOnePaperKeepsSharedReferences',bridge.formulaCache.documents.has(ca.id));
    b.deleted=true;await b.saveTx();await bridge.library.settled();await bridge.formulaCache.reconcile();
    check('deletingLastPaperRemovesFormulaJson',!bridge.formulaCache.documents.has(ca.id)&&!await IOUtils.exists(PathUtils.join(bridge.formulaCache.root,ca.id+'.json')));
    const c=await makePaper('Formula cache disabled cleanup'),sc=await attach(c);
    const cc=await bridge.formulaCache.context({itemID:sc.id});await bridge.formulaCache.store(cc,'test',sel,'q');
    Zotero.Notifier.unregisterObserver(bridge.notifier);
    try {
      c.deleted=true;await c.saveTx();
      check('disabledDeletionInitiallyRetained',bridge.formulaCache.documents.has(cc.id));
      await bridge.formulaCache.settled();bridge.formulaCache=new Cache(bridge);await bridge.formulaCache.load();
      check('startupRemovesDisabledTimeOrphans',!bridge.formulaCache.documents.has(cc.id));
    } finally {bridge.notifier=Zotero.Notifier.registerObserver(bridge.observer,['tab','item'],'paperbridge');}
  } finally {bridge.request=originalRequest;bridge.getKey=originalGetKey;}
  return state;
};
