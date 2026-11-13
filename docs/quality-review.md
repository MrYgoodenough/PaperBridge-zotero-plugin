# Offline CI and fixed-paper quality review

This entry point separates reproducible PDF structure checks from explicitly recorded human semantic and visual review. It never translates, contacts a provider, loads credentials, or invents scores.

## Lightweight CI

`.github/workflows/ci.yml` is configured to run one Linux job with the locked Python 3.12 project environment and Node 22. Dependency installation requires network access; the checks themselves need no external services:

- `pytest tests`, with external plugin autoload and inherited pytest options disabled;
- all built-in Node suites matching `tests/test_*.cjs`, including annotation logic, not native UI acceptance;
- Python syntax via AST, and addon/test JavaScript syntax via `node --check`;
- existing build/update contracts using tiny fixtures for three platforms × two Python modes, including XPI names, manifests, checksums and update feeds.

It does not stage a complete runtime, launch Zotero, use real API keys, call paid APIs, impose a package-size hard gate, or run a three-platform GUI matrix. A missing optional reference PDF remains an explicit pytest skip. New Python tests under `tests/` and Node suites matching `tests/test_*.cjs` are collected automatically by `scripts/check_offline.py`.

The workflow is configured but **has not run on GitHub for this implementation**. Local test results do not establish a GitHub CI pass, native acceptance or publication.

The runner removes inherited Python/native-library paths and common credential environment variables from child processes. Its pytest socket guard blocks external DNS/TCP and permits only local service connections. This is an accidental-network-call guard, **not an OS sandbox**; it does not constrain arbitrary subprocesses. Existing subprocess tests use local fixtures. Standalone integration/translation scripts in `tests/` are not executed by pytest collection.

## Project environment commands

Run from the project root after the existing environment setup. No new dependencies are introduced. `uv run --offline --no-sync` uses the existing project `.venv`, without resolving or downloading packages:

```text
uv run --offline --no-sync python scripts/check_offline.py
uv run --offline --no-sync python scripts/review_quality.py --case liblinear-2008 --report .runtime/quality/liblinear-report.json
```

If uv is not on PATH, use the setup-provided `.tools/bin/uv` (Linux/macOS) or `.tools\bin\uv.exe` (Windows). Direct project-interpreter equivalents:

```sh
# Linux/macOS; discard inherited ROS/Conda runtime paths before Python starts.
env -u PYTHONHOME -u PYTHONPATH -u LD_LIBRARY_PATH -u LD_PRELOAD \
  .venv/bin/python scripts/check_offline.py
env -u PYTHONHOME -u PYTHONPATH -u LD_LIBRARY_PATH -u LD_PRELOAD \
  .venv/bin/python scripts/review_quality.py --case liblinear-2008 \
  --source /absolute/source.pdf --output /absolute/real-translation.mono.pdf \
  --report .runtime/quality/liblinear-report.json \
  --write-review-template .runtime/quality/liblinear-human.json
```

```powershell
# Windows PowerShell, using this project's own environment.
Remove-Item Env:PYTHONHOME, Env:PYTHONPATH -ErrorAction SilentlyContinue
& .\.venv\Scripts\python.exe scripts\check_offline.py
& .\.venv\Scripts\python.exe scripts\review_quality.py --case liblinear-2008 `
  --source 'C:\papers\source.pdf' --output 'C:\papers\real-translation.mono.pdf' `
  --report .runtime\quality\liblinear-report.json `
  --write-review-template .runtime\quality\liblinear-human.json
```

No PDFs are downloaded automatically. Missing/unreadable source or output PDFs are recorded independently; available checks continue and the report is **not accepted**. Exit code 0 means a report was written, not that quality passed. `--require-acceptance` opts into exit code 1 for an unaccepted report. Invalid CLI/JSON input returns exit code 2. Template creation never overwrites existing human work, and report/template paths cannot overwrite the input PDFs or review files.

## Fixed public corpus

`docs/quality-corpus.json` defines two small, digitally typeset JMLR papers:

| Case | Source pages | Default translated pages | Main checks |
| --- | --- | --- | --- |
| `scikit-learn-2011` | 6 | 2–4 | API names, terminology, tables, reading order, unselected author block/references |
| `liblinear-2008` | 4 | 1–3 | optimization terms, formulas, performance table, unselected bibliography/links |

Each entry records stable publisher landing/PDF URLs, publisher licensing policy, expected page count, source SHA-256, selected pages and specific human check locations. Author copyright is retained; the older PDFs do not specify a CC BY version. The software license mentioned inside a paper is **not** its article license. Only metadata is committed; verify the applicable rights before redistributing a PDF or translated derivative. If the publisher changes the PDF, inspection still runs but source identity is flagged for review; update the corpus only after checking the actual replacement.

This is a reproducible **smoke corpus**, not representative accuracy acceptance across 15–25 papers or 300 human checks. `--pages 1,2-3` can override the translated pages to describe an existing real result; required human sample locations remain those of the fixed case. The report's `scope` records the actual selection separately from the case defaults; a single-page override is not a completed three-page corpus run. `bounded_smoke_selected_pages` records the separately authorized sklearn page 2 / LIBLINEAR page 1 smoke selection without changing either default. Source excerpts and PDF paths may be private: keep generated reports local unless explicitly cleared for publication.

## Automatic evidence

Reports contain file hashes and per-page geometry (size, media/crop boxes, rotation), extracted-text counts/excerpts/hashes, basic CJK/replacement-character counts, font names/types/embedding, out-of-bounds text spans and link targets. Matched source/output pages are compared for count/geometry, selected-text presence/change, unselected-text preservation and retention of source link targets.

Text or CJK presence is **not** proof of translation; changed text is **not** proof of semantic correctness. Base-14 unembedded fonts can be legitimate and are surfaced for review rather than stopping execution. Embedded fonts do not prove glyph coverage or visible Chinese text. Extracted text cannot establish reading order, clipping, overlap, formula correctness or visual fidelity. Link targets alone do not establish usable click areas. Single-language **mono** PDFs are the comparison contract; dual-page outputs are still inventoried but cannot be treated as a mono-layout acceptance result.

Protection checks are opt-in, because this script does not infer formulas or bibliography boxes. Supply `--regions regions.json`, a JSON list of definitions of this form:

```json
[
  {"page": 2, "bbox": [50, 200, 550, 300], "label": "manually located formula"}
]
```

These are format-only coordinates: replace them with boxes selected on the **actual source**. Pages are one-based; boxes use unrotated, crop-relative PDF points. The script compares extracted text and exact rendered pixel bytes at 144 dpi inside each box, recording hashes and dimensions. Any difference requests review rather than pretending a perceptual score proves safety. Invalid boxes are unassessed. With no boxes, protection remains `not_evaluated`; no detection or preservation claim is made. Inspect source/output pages visually for all human layout checks, including content outside these boxes.

## Human semantic and layout judgement

Create a template with `--write-review-template`, inspect the actual source/output PDFs, then fill the template and rerun with `--review`:

```text
uv run --offline --no-sync python scripts/review_quality.py --case liblinear-2008 --source source.pdf --output real-translation.mono.pdf --regions regions.json --review .runtime/quality/liblinear-human.json --report .runtime/quality/liblinear-reviewed.json
```

Required evidence:

- `case_id`, `source_sha256`, `output_sha256`: template-generated identity of the **actual** artifacts; source must also match the fixed corpus hash;
- `reviewer`, `reviewed_at`: human reviewer and review timestamp;
- `provenance.kind`: `real_translation` only for an actual translation; leave `unknown` when uncertain and use `mock` for simulated output;
- `provenance.provider`, `model`, `prompt_source`: actual provider/model and a reproducible non-secret prompt reference (e.g. source commit plus function, or archived prompt file and hash). Record the generation prompt, not merely the review instructions. For a real cached translation, retain its original generation provenance. Never include keys or credential files;
- each required item: `verdict` (`pass`, `fail`, `not_evaluated`), exact source/output locators and substantive `notes`. Preserve the fixed item ID/page. Notes should describe what was compared and any discrepancy, not an invented score.

The report retains the recorded verdict and independently computes `effective_verdict`. Missing/duplicate items, absent notes/locators, artifact mismatch, missing model/prompt provenance, or `mock`/`unknown` provenance cannot produce an effective semantic pass. Partial work remains unassessed; an evidence-backed failed item produces `fail`. Semantic and visual layout statuses are separate. The script validates bookkeeping, **not the truth of a human's declaration or judgement**; an automated judge/model response is not a substitute for these human entries.

`acceptance=accepted` is narrowly scoped to this case's required human sample items **plus all configured structural checks**, including explicit protection boxes. Unassessed protection or any warning leaves it `not_accepted`; this is not a release-wide or whole-paper semantic guarantee. Mock/synthetic unit PDFs test only this bookkeeping and the structural comparisons, never real translation quality.

## Remaining real evaluation

The entry point does not fetch private Zotero files or locate translations implicitly. The coordinating agent must supply available real artifacts and genuine generation provenance, perform visual/semantic checks, and decide separately whether any bounded, authorized API evaluation is needed. With no real output or human review, semantic quality remains **not evaluated** regardless of passing CI. Broader paper coverage, cross-platform GUI behavior and full-paper semantic quality still require separate evidence.

## Bounded real smoke evidence (November 14, 2026)

The separately authorized run translated **exactly sklearn page 2 and LIBLINEAR page 1**, once each, through the normal engine; all other pages remain original. The three-page defaults above were not translated or accepted. Local artifacts live under `.runtime/quality-p1-20261114/`; each case has `translated.pdf`, `generation.json`, `provider-evidence.json`, `prompt.json`, `quality.json`, `review.json`, selected-page renders and an unfilled `human-unassessed.json`. `summary.json` indexes the evidence; `assistant-inspection.md` records an explicitly non-human semantic/visual spot inspection. Engine source snapshots and actual-byte hashes bind the provenance to the dirty working tree rather than a Git revision alone.

| Case / selected page | Requests | Provider-reported input / output tokens | Engine quality | Review acceptance |
| --- | --- | --- | --- | --- |
| sklearn / 2 | 2 | 1,002 / 698 | partial: 6 applied-but-unchanged entries remain unknown | not accepted |
| LIBLINEAR / 1 | 2 | 1,293 / 995 | partial: 10 applied-but-unchanged entries remain unknown | not accepted |

All four actual provider calls returned `deepseek-flash`; SDK retries, paid reruns, API probes and local paragraph-cache hits were zero. Usage is fully reported (2,295 input / 1,693 output total; no cached input); no monetary cost was estimated. Eight unselected pages passed exact text and 144-dpi pixel preservation checks. New Chinese fonts are embedded; original unembedded Base-14 fonts remain a structural warning. Font/embed acceptance and native copy/search behavior remain pending, not a font-quality pass.

The inspected Chinese prose is readable and the selected terminology/numeric qualifications were recognizable, **not human-accepted**. Actual layout issues remain: sklearn's second affiliation wraps inside “sur Yvette”; LIBLINEAR's copyright glyph separates into `c○`. Extracted compatibility ideographs/nonbreaking hyphens also need copying/search review. Both PDFs contain zero link annotations, so target-preservation passes are empty-target comparisons, not proof of clickable URLs. Both reports remain `needs_review` / `not_accepted`, with semantic and visual human verdicts `not_evaluated`; native copy/search and human bilingual/layout acceptance remain pending. Translated display math/tables and broader corpus evaluation remain separate checks. No public PDFs or diagnostic ZIPs are published by this run.

## Offline synthetic links versus native acceptance

The separate two-page synthetic link pipeline exercises success and lost-response simulation with **zero actual network/provider calls**. Its simulated responses/usage are not paid-corpus evidence. PDF link preservation in that pipeline does not establish clickable-link behavior in Zotero, and the real papers above have no link annotations to exercise it.

Final Linux Zotero 10.0.8 evidence is indexed in `.runtime/p0-p1-native-verification.json`, tied to the actual installed XPI hashes for bundled/local Python. Each variant passed 21 annotation-create/close/delete and 8 process-restart/standalone-reader checks, plus the native manual-upgrade, task/settings and reader smoke checks. Both selected real pages rendered selectable Chinese. A trusted click on the synthetic pipeline's decoded native internal-link hotspot navigated from page 2 to page 1; this accepts that page-level link behavior, not precise body alignment or the real papers' empty link comparisons. All final processes exited 0 and their databases passed integrity checks. Windows native access is blocked by SSH; no new macOS native acceptance or package replacement is claimed. See [release verification](releasing.md) for local consistency and publication boundaries, independently of human quality review.
