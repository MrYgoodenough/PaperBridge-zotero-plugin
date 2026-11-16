/** Create native Zotero notes from translated annotations or an explicit selection. */
/* global Zotero, DOMParser */
// The module is loaded into the addon's script scope; it does not register reader UI.
var PaperBridgeNotes = (() => {
  // Bound accidental oversized selections without silently truncating their content.
  const MAX_TEXT_LENGTH = 200000;
  // Allow cached raster annotations while bounding the complete serialized note.
  const MAX_HTML_LENGTH = 8000000;
  // Page labels and optional unit identities are short provenance fields, not document bodies.
  const MAX_PROVENANCE_LENGTH = 256;
  // Match Zotero's default highlight color for unsaved selection serialization.
  const SELECTION_COLOR = '#ffd400';
  // Native note schema 10 supports both highlights and underlines in Zotero 10.0.8.
  const NOTE_SCHEMA_VERSION = 10;
  // Preserve only inert formatting, native citation metadata, and cached raster images.
  const SAFE_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'blockquote', 'span', 'strong',
    'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'br', 'img', 'ul', 'ol', 'li']);
  // Never expose active content, even as visible template text.
  const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template']);
  // Only simultaneous equivalent requests share a note; later explicit actions remain independent.
  const pending = new Map();

  /** Escape text and attribute values in HTML owned by this module. */
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  /** Reject invalid content rather than changing the caller's actual selection. */
  function textValue(value, label, limit = MAX_TEXT_LENGTH) {
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error(label + ' is invalid or too long');
    }
    return value;
  }

  /** Validate zero-based physical pages without guessing PDF labels or source correspondence. */
  function pageNumber(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= Number.MAX_SAFE_INTEGER) {
      throw new Error('A valid zero-based translated PDF pageIndex is required');
    }
    return pageIndex + 1;
  }

  /** Accept persisted native PDFs only; no file paths or annotation state are changed. */
  function attachmentItem(value, label) {
    const item = value?.id && Zotero.Items.get(value.id);
    if (!item?.isPDFAttachment?.() || item.deleted || !item.key || !item.libraryID) {
      throw new Error(label + ' must be an existing, non-trashed Zotero PDF attachment');
    }
    return item;
  }

  /** Check note permissions, not file-edit or annotation-author permissions. */
  function context(translatedAttachment, sourceAttachment) {
    if (!Zotero.Item || !Zotero.Items?.get || !Zotero.Libraries?.get || !Zotero.URI?.getItemURI
      || !Zotero.URI.getLibraryPath || !Zotero.EditorInstanceUtilities?.serializeAnnotations) {
      throw new Error('The native Zotero note APIs are unavailable');
    }
    const attachment = attachmentItem(translatedAttachment, 'Translated attachment');
    const library = Zotero.Libraries.get(attachment.libraryID);
    const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
    if (!library?.editable || !['user', 'group'].includes(library.libraryType)
      || attachment.parentID && (!parent?.isRegularItem?.() || parent.deleted
        || parent.libraryID !== attachment.libraryID || !parent.isEditable())) {
      throw new Error('The translated attachment library or parent item is read-only or unavailable');
    }
    const source = sourceAttachment == null ? null : attachmentItem(sourceAttachment, 'Source attachment');
    if (source && (source.libraryID !== attachment.libraryID
      || (source.parentID || null) !== (attachment.parentID || null))) {
      throw new Error('The source attachment must belong to the same library and paper');
    }
    // A PDF can be file-read-only while its library still permits independent notes.
    return { attachment, source, parent, libraryID: attachment.libraryID, attachmentKey: attachment.key };
  }

  /** Construct Zotero's documented open-pdf link for personal and group libraries. */
  function attachmentLink(item, pageIndex, annotationKey) {
    const path = Zotero.URI.getLibraryPath(item.libraryID);
    const libraryPath = path.startsWith('users/') ? 'library' : path;
    if (libraryPath !== 'library' && !/^groups\/\d+$/.test(libraryPath)) {
      throw new Error('This Zotero library does not support PDF backlinks');
    }
    let url = 'zotero://open-pdf/' + libraryPath + '/items/' + encodeURIComponent(item.key);
    if (pageIndex !== undefined) {
      url += '?page=' + pageNumber(pageIndex);
      if (annotationKey) url += '&annotation=' + encodeURIComponent(annotationKey);
    }
    return url;
  }

  /** Rebuild serializer HTML with an allowlist instead of trusting note templates or tags. */
  function sanitizeHTML(html) {
    if (typeof html !== 'string' || html.length > MAX_HTML_LENGTH) {
      throw new Error('The serialized note is invalid or too large');
    }
    const Parser = typeof DOMParser === 'function' ? DOMParser : Zotero.getMainWindow?.()?.DOMParser;
    if (!Parser) throw new Error('The native HTML parser is unavailable for safe note creation');
    const document = new Parser().parseFromString('', 'text/html');
    // Template contents stay inert while parsing, including remote images in custom templates.
    const template = document.createElement('template');
    template.innerHTML = html;

    /** Copy inert nodes, keeping only the metadata used by Zotero's note editor. */
    function render(node) {
      if (node.nodeType === 3) return escapeHTML(node.nodeValue);
      if (node.nodeType !== 1) return '';
      const tag = node.localName.toLowerCase();
      if (DROP_TAGS.has(tag)) return '';
      const children = Array.from(node.childNodes, render).join('');
      if (!SAFE_TAGS.has(tag)) return children;
      let attributes = '';
      if (tag === 'span') {
        const className = node.getAttribute('class');
        if (['highlight', 'underline', 'citation'].includes(className)) {
          attributes += ' class="' + className + '"';
        }
      }
      if (tag === 'span' || tag === 'img') {
        for (const name of ['data-annotation', 'data-citation']) {
          const value = node.getAttribute(name);
          if (value) {
            // Re-encode JSON so malformed attributes cannot escape their quoted container.
            const encoded = encodeURIComponent(JSON.stringify(JSON.parse(decodeURIComponent(value))));
            attributes += ' ' + name + '="' + escapeHTML(encoded) + '"';
          }
        }
      }
      if (tag === 'img') {
        const src = node.getAttribute('src') || '';
        if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) {
          throw new Error('Only native cached PNG/JPEG annotation images can be added to notes');
        }
        attributes += ' src="' + escapeHTML(src) + '"';
        for (const name of ['width', 'height']) {
          const value = node.getAttribute(name);
          if (/^[1-9]\d*$/.test(value || '')) attributes += ' ' + name + '="' + value + '"';
        }
      }
      if (tag === 'br' || tag === 'img') return '<' + tag + attributes + '>';
      return '<' + tag + attributes + '>' + children + '</' + tag + '>';
    }

    return Array.from(template.content.childNodes, render).join('');
  }

  /** Collapse duplicate in-flight actions without a database or a persistent content index. */
  async function once(key, operation) {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(operation);
    pending.set(key, promise);
    try { return await promise; }
    finally { pending.delete(key); }
  }

  /** Save only after all serialization succeeds; expose the native key on uncertain failure. */
  async function saveNote(ctx, jsonAnnotations, title, unitID) {
    const { html, citationItems } = Zotero.EditorInstanceUtilities.serializeAnnotations(jsonAnnotations, true);
    const safeHTML = sanitizeHTML(html);
    if (!safeHTML.trim() || !Array.isArray(citationItems)) {
      throw new Error('No valid annotation content or citation metadata could be serialized');
    }
    let body = '<h1>' + escapeHTML(title) + '</h1>\n' + safeHTML;
    // Explicit links survive custom templates that omit native citation/annotation spans.
    for (const annotation of jsonAnnotations) {
      const label = '译文 · 第 ' + annotation.pageLabel + ' 页';
      body += '<p><a href="' + escapeHTML(attachmentLink(ctx.attachment,
        annotation.position.pageIndex, annotation.id)) + '">' + escapeHTML(label) + '</a></p>';
    }
    if (ctx.source) {
      // No source page is asserted: matching physical pages is not a semantic alignment.
      body += '<p><a href="' + escapeHTML(attachmentLink(ctx.source)) + '">原文</a></p>';
    }
    const metadata = escapeHTML(encodeURIComponent(JSON.stringify(citationItems)));
    // Keep optional provenance out of the readable note body and native PDF links.
    const provenance = unitID ? ' data-paperbridge-unit="' + escapeHTML(unitID) + '"' : '';
    const noteHTML = '<div data-citation-items="' + metadata + '" data-schema-version="'
      + NOTE_SCHEMA_VERSION + '"' + provenance + '>' + body + '</div>';
    if (noteHTML.length > MAX_HTML_LENGTH) throw new Error('The complete note is too large');
    // Recheck permissions after asynchronous annotation/image loading, before the sole write.
    const current = context(ctx.attachment, ctx.source);
    if ((current.parent?.id || null) !== (ctx.parent?.id || null)
      || current.libraryID !== ctx.libraryID || current.attachmentKey !== ctx.attachmentKey) {
      throw new Error('The translated attachment changed ownership; create the note again explicitly');
    }
    const note = new Zotero.Item('note');
    note.libraryID = current.attachment.libraryID;
    if (current.parent) note.parentID = current.parent.id;
    // Let saveTx allocate the key: identifying a new Item first prevents setNote from loading its data.
    note.setNote(noteHTML);
    try {
      await note.saveTx();
    } catch (cause) {
      const noteKey = note.key || null;
      const identity = noteKey ? 'Check native note key ' + noteKey : 'No native note key was assigned; check the paper notes';
      const error = new Error('Zotero could not confirm note creation. ' + identity
        + ' in library ' + note.libraryID + ' before retrying. ' + (cause?.message || cause));
      error.code = 'NOTE_SAVE_FAILED';
      error.noteKey = noteKey;
      error.libraryID = note.libraryID;
      error.cause = cause;
      throw error;
    }
    return note;
  }

  /** Read only this attachment's persisted native annotation children, accepting item IDs or keys. */
  async function createFromAnnotations({ translatedAttachment, sourceAttachment, annotationIDs } = {}) {
    const ctx = context(translatedAttachment, sourceAttachment);
    if (!ctx.attachment.getAnnotations || !ctx.attachment.loadDataType || !Zotero.Annotations?.toJSON) {
      throw new Error('The native Zotero annotation APIs are unavailable');
    }
    if (annotationIDs !== undefined && (!Array.isArray(annotationIDs) || !annotationIDs.length)) {
      throw new Error('Select at least one native translated annotation');
    }
    const requestedIDs = annotationIDs?.slice();
    // Claim the operation before native data loading, so even slow duplicate reads share it.
    const identities = requestedIDs?.map(id => typeof id === 'number' ? Zotero.Items.get(id)?.key || id : id);
    const key = JSON.stringify(['annotations', ctx.attachment.libraryID, ctx.attachment.key,
      ctx.source?.key, identities ? [...new Set(identities)].sort() : null]);
    return once(key, async () => {
      await ctx.attachment.loadDataType('childItems');
      const children = ctx.attachment.getAnnotations().filter(item => !item.deleted && item.isAnnotation()
        && item.parentID === ctx.attachment.id && item.libraryID === ctx.attachment.libraryID);
      let selected = children;
      if (requestedIDs !== undefined) {
        selected = requestedIDs.map(id => {
          const item = children.find(child => child.id === id || child.key === id);
          if (!item) throw new Error('The selected annotation does not belong to the translated PDF: ' + id);
          return item;
        });
      }
      selected = [...new Set(selected)];
      if (!selected.length) throw new Error('The translated PDF has no selected native annotations');
      const jsonAnnotations = [];
      let contentLength = 0;
      for (const item of selected) {
        await item.loadAllData();
        if (item.deleted || item.parentID !== ctx.attachment.id || item.libraryID !== ctx.attachment.libraryID) {
          throw new Error('A selected annotation was deleted or moved before note creation');
        }
        const json = await Zotero.Annotations.toJSON(item);
        if (!['highlight', 'underline', 'note', 'text', 'image', 'ink'].includes(json.type)) {
          throw new Error('Unsupported native annotation type: ' + json.type);
        }
        const page = pageNumber(json.position?.pageIndex);
        const text = textValue(json.text || '', 'Annotation text');
        const comment = textValue(json.comment || '', 'Annotation comment');
        if (!text.trim() && !comment.trim() && !json.image) {
          throw new Error('A selected annotation has no text/comment or cached image: ' + item.key);
        }
        contentLength += text.length + comment.length + (json.image?.length || 0);
        if (contentLength > MAX_HTML_LENGTH) throw new Error('The selected annotation content is too large');
        jsonAnnotations.push({ ...json, id: item.key, attachmentItemID: ctx.attachment.id,
          text, comment, pageLabel: textValue(json.pageLabel || String(page), 'Page label', MAX_PROVENANCE_LENGTH) });
      }
      return saveNote(ctx, jsonAnnotations, '译文批注汇总');
    });
  }

  /** Cite actual selection text without creating an annotation or guessing a corresponding source. */
  async function createFromSelection({ translatedAttachment, sourceAttachment, text, pageIndex, pageLabel, unitID } = {}) {
    const ctx = context(translatedAttachment, sourceAttachment);
    text = textValue(text, 'Selection text');
    if (!text.trim()) throw new Error('Select actual text in the translated PDF first');
    const page = pageNumber(pageIndex);
    pageLabel = textValue(pageLabel === undefined ? String(page) : pageLabel, 'Page label', MAX_PROVENANCE_LENGTH);
    if (!pageLabel.trim()) throw new Error('Page label must not be empty');
    if (unitID !== undefined) unitID = textValue(unitID, 'Unit ID', MAX_PROVENANCE_LENGTH);
    const key = JSON.stringify(['selection', ctx.attachment.libraryID, ctx.attachment.key,
      ctx.source?.key, text, pageIndex, pageLabel, unitID]);
    return once(key, async () => {
      const annotation = { attachmentItemID: ctx.attachment.id,
        type: 'highlight', text, comment: '', color: SELECTION_COLOR, pageLabel, position: { pageIndex } };
      return saveNote(ctx, [annotation], '译文选区', unitID);
    });
  }

  return { createFromAnnotations, createFromSelection };
})();
