/* Runs only in the disposable test profile, never included in the XPI. */
var runLifecycleTests = async bridge => {
  const root = PAPERBRIDGE_TEST_ROOT;
  const report = {version:bridge.runtime.version,api_calls:0,checks:{}};
  const assert = (condition,message) => { if (!condition) throw new Error(message); };
  const health = await bridge.request("/health");
  const {Subprocess} = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const database = PathUtils.join(bridge.runtime.cache,"paragraphs.sqlite");
  async function paragraphRows(doc, seed=false) {
    const code = "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); " +
      (seed ? "db.execute('INSERT OR REPLACE INTO paragraphs (key,translation,document_key) VALUES (?,?,?)',('lifecycle-'+sys.argv[2],'fixture translation',sys.argv[2])); db.commit(); " : "") +
      "print(db.execute('SELECT count(*) FROM paragraphs WHERE document_key=?',(sys.argv[2],)).fetchone()[0]); db.close()";
    const process = await Subprocess.call({command:health.python,arguments:["-I","-S","-c",code,database,doc],stderr:"stdout"});
    const output = await process.stdout.readString();
    const result = await process.wait();
    assert(result.exitCode===0,"SQLite fixture failed: "+output);
    return Number(output.trim());
  }
  const tick = async () => { await Zotero.Promise.delay(100); await bridge.library.settled(); assert(!bridge.library.lastError,bridge.library.lastError); };
  // Previous failed runs can leave fixture owners; never touch other items.
  for (const key of new Set(bridge.library.records.map(r => r.libraryID+":"+r.ownerKey))) {
    const [libraryID,itemKey]=key.split(":");
    const owner=await bridge.library.item(Number(libraryID),itemKey);
    if (owner?.isRegularItem() && owner.getField("title").startsWith("PaperBridge lifecycle · ")) await owner.eraseTx();
  }
  await tick();
  async function fixture(name) {
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title","PaperBridge lifecycle · "+name); await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({file:root+"/.runtime/lifecycle-fixtures/"+name+".pdf",parentItemID:parent.id});
    const translated = await Zotero.Attachments.importFromFile({file:root+"/.runtime/lifecycle-fixtures/translated.pdf",parentItemID:parent.id});
    translated.setField("title","译文 · zh-CN · lifecycle fixture");
    translated.addRelation("dc:relation",Zotero.URI.getItemURI(source)); await translated.saveTx();
    const config={model:"deepseek-flash",baseURL:"https://api.deepseek.com",language:"zh-CN",pages:""};
    const descriptor=await bridge.library.describe(source,translated,config);
    const record=await bridge.library.put(source,translated,config,descriptor,await IOUtils.stat(await source.getFilePathAsync()));
    const folder=PathUtils.join(bridge.runtime.state,"jobs",descriptor.fingerprint);
    await IOUtils.makeDirectory(folder,{ignoreExisting:true});
    await IOUtils.copy(root+"/.runtime/lifecycle-fixtures/translated.pdf",PathUtils.join(folder,"translated.pdf"));
    await IOUtils.writeUTF8(PathUtils.join(folder,"usage.json"),JSON.stringify({api_requests:0}));
    await paragraphRows(descriptor.document_key,true);
    return {parent,source,translated,record,descriptor,folder,translationPath:await translated.getFilePathAsync()};
  }
  async function checkCleared(fixture) {
    await tick();
    assert(!await bridge.library.item(fixture.record.libraryID,fixture.record.attachmentKey),"Generated attachment survived citation deletion");
    assert(!await IOUtils.exists(fixture.translationPath),"Generated PDF file survived citation deletion");
    assert(!await IOUtils.exists(fixture.folder),"Full PDF cache survived last owner deletion");
    assert(await paragraphRows(fixture.descriptor.document_key)===0,"Paragraph cache survived last owner deletion");
    assert(!bridge.library.records.includes(fixture.record),"Stale index record survived deletion");
  }

  const sourceGone=await fixture("source-gone");
  await sourceGone.source.eraseTx(); await tick();
  assert(await sourceGone.translated.fileExists(),"Removing original attachment deleted translation");
  assert(await IOUtils.exists(sourceGone.folder),"Removing original attachment deleted cache while citation exists");
  const saved=await bridge.openExisting({itemID:sourceGone.parent.id});
  assert(saved.id===sourceGone.translated.id,"Cannot load translation without original attachment");
  report.checks.original_attachment_removed_translation_retained=true;
  sourceGone.parent.deleted=true; await sourceGone.parent.saveTx();
  await checkCleared(sourceGone);
  report.checks.citation_trashed_translation_and_cache_deleted=true;
  sourceGone.parent.deleted=false; await sourceGone.parent.saveTx(); await tick();
  assert(!await IOUtils.exists(sourceGone.translationPath),"Restoring citation resurrected deleted translation");
  report.checks.restore_does_not_resurrect_translation=true;
  await sourceGone.parent.eraseTx();

  const fileGone=await fixture("file-gone");
  await IOUtils.remove(await fileGone.source.getFilePathAsync()); await tick();
  assert(await fileGone.translated.fileExists(),"Removing original file deleted translation");
  assert((await bridge.openExisting({itemID:fileGone.parent.id})).id===fileGone.translated.id,"Cannot load translation without original file");
  assert((await bridge.translate({itemID:fileGone.parent.id})).id===fileGone.translated.id,"Translate button did not reuse translation when original file is missing");
  report.checks.original_file_removed_translation_retained=true;
  await fileGone.parent.eraseTx(); await checkCleared(fileGone);
  report.checks.citation_permanently_erased_cache_deleted=true;

  const permanent=await fixture("permanent");
  await permanent.parent.eraseTx(); await checkCleared(permanent);
  report.checks.direct_permanent_delete_cleans_translation_and_cache=true;

  const a=await fixture("shared"),b=await fixture("shared");
  assert(a.descriptor.fingerprint===b.descriptor.fingerprint,"Shared fixture fingerprint mismatch");
  a.parent.deleted=true; await a.parent.saveTx(); await tick();
  assert(!await IOUtils.exists(a.translationPath),"First citation translation not deleted");
  assert(await b.translated.fileExists() && await IOUtils.exists(b.folder),"Deleting one citation damaged its peer");
  assert(await paragraphRows(b.descriptor.document_key)>0,"Shared paragraph cache removed too early");
  report.checks.shared_cache_preserved_for_other_citation=true;
  b.parent.deleted=true; await b.parent.saveTx(); await checkCleared(b);
  report.checks.last_shared_owner_deletes_cache=true;
  await a.parent.eraseTx(); await b.parent.eraseTx();

  const collected=await fixture("collection");
  const collection=new Zotero.Collection(); collection.name="PaperBridge lifecycle disposable"; await collection.saveTx();
  collected.parent.addToCollection(collection.id); await collected.parent.saveTx();
  collected.parent.removeFromCollection(collection.id); await collected.parent.saveTx(); await tick();
  assert(await collected.translated.fileExists() && await IOUtils.exists(collected.folder),"Removing a collection membership deleted translation/cache");
  report.checks.collection_removal_preserves_translation=true;
  await collected.parent.eraseTx(); await checkCleared(collected); await collection.eraseTx();

  const missed=await fixture("missed");
  Zotero.Notifier.unregisterObserver(bridge.notifier);
  missed.parent.deleted=true; await missed.parent.saveTx();
  assert(await IOUtils.exists(missed.translationPath),"Test needs an event missed while disabled");
  bridge.library=new bridge.library.constructor(bridge); await bridge.library.load();
  bridge.notifier=Zotero.Notifier.registerObserver(bridge.observer,["tab","item"],"paperbridge");
  assert(!await IOUtils.exists(missed.translationPath) && !await IOUtils.exists(missed.folder),"Startup reconciliation failed");
  report.checks.missed_deletion_reconciled_after_restart=true;
  await missed.parent.eraseTx(); await tick();

  report.translationsRoot=PathUtils.join(Zotero.DataDirectory.dir,"storage");
  report.cacheRoot=bridge.runtime.cache;
  report.indexPath=bridge.library.path;
  report.ok=Object.values(report.checks).every(Boolean);
  await IOUtils.writeUTF8(root+"/docs/lifecycle-"+bridge.runtime.version+".json",JSON.stringify(report,null,2));
  return report;
};
