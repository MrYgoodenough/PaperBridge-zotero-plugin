(async () => {
  const root=PAPERBRIDGE_TEST_ROOT,bridge=Zotero.PaperBridge,report={version:Zotero.version,plugin:'0.4.2',checks:{}};
  const check=(name,value)=>{report.checks[name]=!!value;if(!value)throw Error(name);};
  try {
    await bridge.ready;
    const fixture=await IOUtils.readJSON(root+'/.runtime/zotero042-restart-fixture.json');
    const item=await Zotero.Items.getAsync(fixture.translatedID);
    check('realRestartPreservesJson',bridge.formulaCache.documents.has(fixture.documentID));
    check('realRestartPreservesLatex',Object.values(bridge.formulaCache.documents.get(fixture.documentID).entries).some(e=>e.latex===fixture.latex));
    const health=await bridge.request('/health');
    check('engineUpgradeLeavesFormulaCache',health.version==='0.4.2'&&bridge.formulaCache.documents.has(fixture.documentID));
    const regions=await bridge.formulas.regions({itemID:item.id},fixture.page);
    const selection=regions.find(r=>bridge.formulaCache.key(r.selection)===fixture.entryKey)?.selection;
    check('restartFormulaIdentityStable',!!selection);
    let apiCalls=0;const request=bridge.request;
    bridge.getKey=()=>'';
    bridge.request=async function(path,...args){if(path==='/formulas/latex'){apiCalls++;throw Error('Unexpected provider call');}return request.call(this,path,...args);};
    const copied=await bridge.formulas.copy({itemID:item.id},selection,true);
    check('realRestartCopiesWithoutApiKey',copied==='$$'+fixture.latex+'$$'&&apiCalls===0);
    await bridge.stop();
    check('restartShutdownClean',!bridge.runtime.process&&bridge.formulas.readers.size===0);
    report.ok=true;
  }catch(error){report.ok=false;report.error=String(error);report.stack=error.stack;}
  await IOUtils.writeJSON(root+'/.runtime/zotero042-restart-test.json',report);
  Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
})();
