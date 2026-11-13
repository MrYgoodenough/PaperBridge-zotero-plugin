/** Persist the translated pane's native Zotero annotations on its PDF attachment. */
/* global Zotero, Components */
// One independent adapter binds the translated attachment to the existing native reader.
var TranslationAnnotations = class {
  /** Bind one attachment; all writes remain ordered after its pane closes. */
  constructor(attachment, frame, onError) {
    this.attachment = attachment;
    this.frame = frame;
    this.onError = onError;
    this.pending = Promise.resolve();
    this.saved = new Map();
    this.itemKeys = new Map();
    this.instanceID = "paperbridge-annotations-" + Zotero.DataObjectUtilities.generateKey();
  }

  /** Detect the official persistence APIs without disabling ordinary PDF reading. */
  static supported(attachment) {
    return !!(attachment.getAnnotations && attachment.isEditable && Zotero.Annotations?.toJSON
      && Zotero.Annotations.saveFromJSON && Zotero.Items?.getByLibraryAndKey
      && Zotero.Notifier?.Queue && Zotero.Notifier.registerObserver
      && Zotero.DataObjectUtilities?.generateKey);
  }

  /** Respect Zotero's attachment and library editability, including trashed parents. */
  readOnly() {
    const item = Zotero.Items.get(this.attachment.id) || this.attachment;
    return !item.isEditable() || item.deleted || !!item.parentItem?.deleted;
  }

  /** Compare native annotation content while ignoring transient reader properties. */
  signature(annotation) {
    return JSON.stringify([annotation.type, annotation.text || "", annotation.comment || "",
      annotation.color, annotation.pageLabel || "", annotation.sortIndex, annotation.position,
      annotation.tags || [], annotation.image || ""]);
  }

  /** Convert a real annotation item to the reader's id-based JSON contract. */
  async json(item) {
    const annotation = await Zotero.Annotations.toJSON(item);
    annotation.id = item.key;
    delete annotation.key;
    annotation.tags ||= [];
    this.itemKeys.set(item.id, item.key);
    return annotation;
  }

  /** Read annotations only from this translated attachment, never the source PDF. */
  async load() {
    const annotations = [];
    for (const item of this.attachment.getAnnotations()) {
      try {
        const annotation = await this.json(item);
        this.saved.set(annotation.id, this.signature(annotation));
        annotations.push(annotation);
      } catch (error) {
        // A damaged annotation must not prevent the remaining PDF from opening.
        Zotero.logError(error);
      }
    }
    return annotations;
  }

  /** Report a failed write visibly, stopping edits only in the affected pane. */
  fail(error) {
    this.failed = true;
    Zotero.logError(error);
    // A write can finish after its iframe has already been removed by closeSplit.
    try { this.reader?.setReadOnly(true); } catch (displayError) { Zotero.logError(displayError); }
    try { this.onError(error); } catch (displayError) { Zotero.logError(displayError); }
  }

  /** Serialize DB operations and consume errors for iframe callbacks without promises. */
  enqueue(operation) {
    this.pending = this.pending.then(operation).catch(error => this.fail(error));
    return this.pending;
  }

  /** Save native JSON via Zotero, guarding against accidental cross-attachment reparenting. */
  async write(annotations, notifierQueue) {
    for (const value of annotations) {
      const annotation = JSON.parse(JSON.stringify(value));
      const key = annotation.id;
      const existing = Zotero.Items.getByLibraryAndKey(this.attachment.libraryID, key);
      if (existing && (!existing.isAnnotation() || existing.parentID !== this.attachment.id)) {
        throw new Error("Annotation does not belong to the translated attachment: " + key);
      }
      if (existing && annotation.image && (this.readOnly() || !existing.isEditable()
        || existing.annotationIsExternal || annotation.readOnly)) {
        await this.saveImage(existing, annotation.image);
        continue;
      }
      if (this.readOnly() || annotation.readOnly || annotation.isExternal
        || existing && (!existing.isEditable() || existing.annotationIsExternal)) {
        throw new Error("The translated annotation is read-only");
      }
      // The reader supplies full native JSON, including image/ink positions.
      annotation.key = key;
      delete annotation.id;
      delete annotation.authorName;
      const notifierData = { instanceID: this.instanceID };
      if (annotation.onlyTextOrComment) notifierData.autoSyncDelay = Zotero.Notes.AUTO_SYNC_DELAY;
      const item = await Zotero.Annotations.saveFromJSON(this.attachment, annotation,
        { notifierQueue, notifierData });
      if (annotation.image) await this.saveImage(item, annotation.image);
      this.itemKeys.set(item.id, item.key);
      this.saved.set(key, this.signature(value));
    }
  }

  /** Let Zotero manage image/ink cache files instead of inventing a sidecar store. */
  async saveImage(item, image) {
    const response = await this.frame.fetch(image);
    await Zotero.Annotations.saveCacheImage(item, await response.blob());
  }

  /** Erase only editable annotations actually parented by this translated PDF. */
  async erase(keys, notifierQueue) {
    if (keys.length && this.readOnly()) throw new Error("The translated attachment is read-only");
    for (const key of keys) {
      const item = Zotero.Items.getByLibraryAndKey(this.attachment.libraryID, key);
      if (!item || !item.isAnnotation() || item.parentID !== this.attachment.id) continue;
      if (!item.isEditable() || item.annotationIsExternal) throw new Error("The translated annotation is read-only");
      await item.eraseTx({ notifierQueue, notifierData: { instanceID: this.instanceID } });
      this.saved.delete(key);
      this.itemKeys.delete(item.id);
    }
  }

  /** Commit native notifications even if one annotation in the batch fails. */
  async commit(annotations, keys = []) {
    const queue = new Zotero.Notifier.Queue();
    try {
      await this.erase(keys, queue);
      await this.write(annotations, queue);
    } finally {
      await Zotero.Notifier.commit(queue);
    }
  }

  /** Provide persistence callbacks to the existing createReader call. */
  options(annotations) {
    return {
      annotations, readOnly: this.readOnly(), showAnnotations: true,
      textSelectionAnnotationMode: Zotero.Prefs.get("reader.textSelectionAnnotationMode"),
      onSaveAnnotations: (values, callback) => {
        if (this.closed) return;
        const snapshot = JSON.parse(JSON.stringify(values));
        this.enqueue(async () => {
          try {
            if (!this.failed && snapshot.length) await this.commit(snapshot);
          } finally {
            // Only a live iframe needs acknowledgement; teardown invalidates its callback.
            if (!this.closed) callback?.();
          }
        });
      },
      onDeleteAnnotations: keys => {
        const snapshot = Array.from(keys);
        if (this.closed || !snapshot.length) return;
        this.enqueue(() => !this.failed && this.commit([], snapshot));
      },
      // Reuse the reader's own menu renderer; never replace its annotation actions.
      onOpenContextMenu: () => this.reader.openContextMenu(this.frame.wrappedJSObject.contextMenuParams),
      onTextSelectionAnnotationModeChange: mode => Zotero.Prefs.set("reader.textSelectionAnnotationMode", mode),
      onSetDataTransferAnnotations: (transfer, values) => {
        const annotations = values.map(value => ({ ...value, attachmentItemID: this.attachment.id }));
        transfer.setData("zotero/annotation", JSON.stringify(annotations));
      }
    };
  }

  /** Reflect attachment-local changes from another native reader or Zotero sync. */
  connect(reader) {
    this.reader = reader;
    this.readerReadOnly = !!(this.failed || this.readOnly());
    const observer = {
      notify: (event, type, ids, extra = {}) => {
        if (type !== "item" || this.closed) return;
        this.enqueue(async () => {
          if (this.closed) return;
          const readOnly = !!(this.failed || this.readOnly());
          // Native setReadOnly also resets the tool; call it only on a permission transition.
          if (readOnly !== this.readerReadOnly) {
            reader.setReadOnly(readOnly);
            this.readerReadOnly = readOnly;
          }
          for (const id of ids) {
            if (extra[id]?.instanceID === this.instanceID) continue;
            if (event === "delete" || event === "trash") {
              const key = this.itemKeys.get(id);
              if (!key) continue;
              reader.unsetAnnotations(Components.utils.cloneInto([key], this.frame));
              this.saved.delete(key);
              this.itemKeys.delete(id);
            } else if (event === "add" || event === "modify") {
              const item = Zotero.Items.get(id);
              if (!item?.isAnnotation() || item.parentID !== this.attachment.id || item.deleted) continue;
              const annotation = await this.json(item);
              reader.setAnnotations(Components.utils.cloneInto([annotation], this.frame));
              this.saved.set(annotation.id, this.signature(annotation));
            }
          }
        });
      }
    };
    this.observerID = Zotero.Notifier.registerObserver(observer, ["item"], "paperbridge-annotations");
  }

  /** Snapshot native state before teardown so Zotero's save debounce cannot lose recent edits. */
  close() {
    if (this.closed) return this.pending;
    // Official Reader has no public flush API; read its state without replacing any methods.
    const state = this.reader?._state?.annotations;
    const snapshot = state && JSON.parse(JSON.stringify(state));
    this.closed = true;
    if (this.observerID !== undefined) Zotero.Notifier.unregisterObserver(this.observerID);
    return this.enqueue(async () => {
      if (this.failed || this.readOnly() || !snapshot) return;
      const present = new Set(snapshot.map(annotation => annotation.id));
      const removed = [...this.saved.keys()].filter(key => !present.has(key));
      const changed = snapshot.filter(annotation => !annotation.readOnly && !annotation.isExternal
        && this.saved.get(annotation.id) !== this.signature(annotation));
      if (changed.length || removed.length) await this.commit(changed, removed);
    });
  }
};
