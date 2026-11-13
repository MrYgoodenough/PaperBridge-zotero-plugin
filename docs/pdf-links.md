# PDF links

`backend/preserve.py::restore_regions` handles links in the existing final PDF
restoration/writeout path. No extra translation pass or upstream patch is used.
Redaction removes overlapping links, and `show_pdf_page` copies graphics but not
annotations; therefore links must be restored separately within that same writeout.

## Rules

- The keys in `ProtectedLayoutModel.regions` identify translated pages, including
  keys with empty lists. Pages absent from this map remain unselected.
- Source hotspots wholly inside a restored figure, table, formula or bibliography
  rectangle are recovered once. Source links on unselected pages are also recovered,
  even if preprocessing removed their annotations.
- On selected pages, source-derived hotspots outside restored rectangles are removed.
  Hotspots crossing a restoration boundary are not reconstructed. A producer's moved
  or otherwise distinct link outside the restored content is retained.
- An inherited internal destination keeps its exact view when its target page is
  unselected or its point lies in a restored rectangle. Otherwise only the target
  page is reliable: the link uses an actual PDF `/Fit` destination, not a made-up
  `/XYZ` point. Distinct producer-supplied destinations are not overwritten.
- Original internal destination arrays are copied with the output page reference,
  preserving view modes and zoom. PyMuPDF 1.26.7 exposes `/Fit` as a `LINK_NAMED`
  page/view pair and does not reliably report XYZ zoom; tests inspect the PDF arrays.

## Limits and verification

This relies on the existing mono output retaining source page order and geometry.
It does not infer body-link alignment from translated text: even an unchanged-looking
source body hotspot on a selected page lacks reliable mapping evidence. Arbitrary
named destinations, outlines and non-link annotations are not rebuilt. Recovery
preserves link actions and hotspots, not custom annotation appearance.

Run the project Python with `-m pytest -q tests/test_pdf_links.py tests/test_preserve.py`.
These tests use small legal synthetic PDFs and no network/provider calls; they cover
URI/GoTo, restored and unselected content, body reflow, exact/page-only targets,
overlapping/boundary regions and unselected rotated-page hotspots.

`tests/offline_quality_pipeline.py` also exercises the real BabelDOC pipeline with a
two-page synthetic source and explicitly simulated completion responses. Only page one
is translated: its stale body hotspot disappears, the untouched second page retains
its URI, and its inherited body target becomes `/Fit`. Success and lost-response cases
both verify these actions without networking. This does not establish real-paper
coverage, exact body-link alignment or native Zotero clicking acceptance.
