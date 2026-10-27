import sys
from pathlib import Path

import numpy as np
import pytest
from sklearn.cluster import DBSCAN
from skimage.metrics import structural_similarity as reference_ssim

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from compact_math import LineClusters, structural_similarity


@pytest.mark.parametrize("dimension,metric", [(1, "euclidean"), (2, "manhattan")])
def test_line_clusters_match_original(dimension, metric):
    rng = np.random.default_rng(42)
    for count in [1, 8, 70, 500]:
        points = rng.integers(0, 90, size=(count, dimension)).astype(float)
        for eps in [0.5, 1.0, 5.0, 20.0]:
            expected = DBSCAN(eps=eps, min_samples=1, metric=metric).fit(points).labels_
            actual = LineClusters(eps, metric=metric).fit(points).labels_
            np.testing.assert_array_equal(actual, expected)


def test_scan_similarity_matches_original():
    rng = np.random.default_rng(19)
    page = rng.integers(0, 256, size=(350, 260), dtype=np.uint8)
    edited = page.copy()
    edited[30:140, 45:75] = 255
    white = np.full_like(page, 255)
    for a, b in [(page, page), (page, edited), (page, white), (white, white)]:
        assert structural_similarity(a, b) == pytest.approx(reference_ssim(a, b), abs=1e-12)
