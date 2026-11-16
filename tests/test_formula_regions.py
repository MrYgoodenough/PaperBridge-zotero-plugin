import sys
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import formula_regions


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_local_regions_extract_complete_formula_in_pdf_coordinates(tmp_path, monkeypatch, rotation):
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
        def predict(self, image):
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
    with pytest.raises(ValueError):
        formula_regions.detect(payload)
