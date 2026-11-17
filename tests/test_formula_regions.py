"""Check local equation extraction, original PDF origins, and retriable model initialization."""
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import formula_regions


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_local_regions_extract_complete_formula_in_pdf_coordinates(tmp_path, monkeypatch, rotation):
    """Extract the complete formula in PDF coordinates at every supported rotation."""
    path = tmp_path / 'fixture.pdf'
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=600)
        page.insert_text((50, 70), 'surrounding prose must stay local')
        page.insert_text((100, 200), 'x = 1/2')
        page.set_rotation(rotation)
        doc.save(path)
    with pymupdf.open(path) as doc:
        page = doc[0]
        unrotated = page.search_for('x = 1/2')[0]
        displayed = unrotated * page.rotation_matrix
        expected = unrotated * ~page.transformation_matrix
        rectangle = [value * 1.5 for value in displayed]
    class Model:
        """Mock only detection; render and extract with real PyMuPDF and NumPy."""

        def predict(self, image):
            """Return the formula box and an unrelated prose box."""
            return [SimpleNamespace(names={0:'isolate_formula',1:'text'}, boxes=[
                SimpleNamespace(cls=0,xyxy=rectangle),SimpleNamespace(cls=1,xyxy=[0,0,100,100])])]
    monkeypatch.setattr(formula_regions, '_MODEL', Model())
    result = formula_regions.detect({'source_path':str(path),'page_index':0})
    assert len(result['regions']) == 1
    region = result['regions'][0]
    assert region['selection']['text'] == 'x = 1/2'
    assert 'surrounding' not in str(region)
    assert region['rect'][0] <= expected.x0 and region['rect'][2] >= expected.x1
    assert region['rect'][1] <= expected.y0 and region['rect'][3] >= expected.y1
    assert all(c['page'] == 0 for c in region['selection']['glyphs'])


@pytest.mark.parametrize('payload', [[],{}, {'source_path':'x.pdf','page_index':-1}, {'source_path':'x.pdf','page_index':'1'}])
def test_rejects_invalid_local_region_request(payload):
    """Reject malformed requests before loading the bundled model."""
    with pytest.raises(ValueError):
        formula_regions.detect(payload)


@pytest.mark.parametrize('rotation, shifted_media', [(90, False), (270, True)])
def test_rotated_cropped_regions_keep_pdf_origins(tmp_path, monkeypatch, rotation, shifted_media):
    """Compare both glyphs and regions with PDF coordinates captured before cropping."""
    path = tmp_path / 'cropped.pdf'
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=600)
        if shifted_media:
            page.set_mediabox(pymupdf.Rect(20, 30, 420, 630))
        page.insert_text((100, 200), 'x = 1/2')
        source_rect = page.search_for('x = 1/2')[0]
        # This oracle predates cropping/rotation; it cannot share the rotated-transform bug.
        source_to_pdf = ~page.transformation_matrix
        expected_glyphs = [{'c': char['c'], 'rect': list(pymupdf.Rect(char['bbox']) * source_to_pdf)}
                           for block in page.get_text('rawdict')['blocks']
                           for line in block.get('lines', []) for span in line['spans']
                           for char in span['chars']]
        padding = formula_regions.REGION_PADDING_POINTS
        expected_rect = pymupdf.Rect(source_rect.x0-padding, source_rect.y0-padding,
                                    source_rect.x1+padding, source_rect.y1+padding) * source_to_pdf
        left = 60 if shifted_media else 40
        page.set_cropbox(pymupdf.Rect(left, 60, left+340, 560))
        page.set_rotation(rotation)
        doc.save(path)
    with pymupdf.open(path) as doc:
        displayed = doc[0].search_for('x = 1/2')[0] * doc[0].rotation_matrix
        rectangle = [value * formula_regions.MAX_RENDER_SCALE for value in displayed]

    class Model:
        """Return the exact visible equation box without changing extraction geometry."""

        def predict(self, image):
            """Supply raster-space coordinates for the actual selected formula."""
            return [SimpleNamespace(names={0: 'isolate_formula'}, boxes=[
                SimpleNamespace(cls=0, xyxy=rectangle),
            ])]

    monkeypatch.setattr(formula_regions, '_MODEL', Model())
    source_bytes = path.read_bytes()
    result = formula_regions.detect({'source_path': str(path), 'page_index': 0})
    assert path.read_bytes() == source_bytes
    assert len(result['regions']) == 1
    region = result['regions'][0]
    assert region['selection']['text'] == 'x = 1/2'
    # Match the existing serialized PDF coordinate precision, not an arbitrary tolerance.
    precision = 10 ** -formula_regions.PDF_COORDINATE_DIGITS
    assert region['rect'] == pytest.approx(list(expected_rect), abs=precision)
    glyphs = region['selection']['glyphs']
    assert len(glyphs) == len(expected_glyphs)
    for actual, expected in zip(glyphs, expected_glyphs):
        assert actual['c'] == expected['c'] and actual['page'] == 0
        assert actual['rect'] == pytest.approx(expected['rect'], abs=precision)


@pytest.mark.parametrize('failure_stage', ['session', 'metadata'])
def test_failed_model_initialization_can_retry(tmp_path, monkeypatch, failure_stage):
    """A failed session or metadata load must leave no published model and allow retry."""
    path = tmp_path / 'fixture.pdf'
    with pymupdf.open() as doc:
        doc.new_page(width=400, height=600)
        doc.save(path)
    cache = tmp_path / 'cache'
    asset = cache / formula_regions.MODEL_RELATIVE_PATH
    asset.parent.mkdir(parents=True)
    asset.touch()  # The mock session needs an existing path, not a real ONNX asset.
    monkeypatch.setenv('PAPERBRIDGE_CACHE_DIR', str(cache))
    metadata = SimpleNamespace(custom_metadata_map={'stride': '32', 'names': "{0: 'isolate_formula'}"})
    session = MagicMock()
    session.get_modelmeta.return_value = metadata
    runtime = ModuleType('onnxruntime')
    runtime.disable_telemetry_events = MagicMock()
    runtime.InferenceSession = MagicMock(return_value=session)
    if failure_stage == 'session':
        runtime.InferenceSession.side_effect = [RuntimeError('fixture initialization failure'), session]
    else:
        session.get_modelmeta.side_effect = [ValueError('fixture initialization failure'), metadata]

    class Model:
        """Check the fields that must exist before the model is exposed to prediction."""

        def predict(self, image):
            """Return an empty layout only after complete, successful initialization."""
            assert self.model is session and self._stride == 32
            assert self._names == {0: 'isolate_formula'} and hasattr(self, 'lock')
            return [SimpleNamespace(names=self._names, boxes=[])]

    engine = ModuleType('engine')
    engine.localize_cache = MagicMock()
    layout = ModuleType('babeldoc.docvision.doclayout')
    layout.OnnxModel = Model
    for name, module in (('engine', engine), ('onnxruntime', runtime),
                         ('babeldoc.docvision.doclayout', layout)):
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(formula_regions, '_MODEL', None)
    request = {'source_path': str(path), 'page_index': 0}
    with pytest.raises(ValueError, match='fixture initialization failure'):
        formula_regions.detect(request)
    assert formula_regions._MODEL is None
    assert formula_regions.detect(request) == {'regions': []}
    assert isinstance(formula_regions._MODEL, Model)
    assert runtime.InferenceSession.call_count == 2
