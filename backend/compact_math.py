"""The two numerical operations used by the pinned PDF engine.

Line grouping uses DBSCAN with min_samples=1: connected components of the
epsilon-neighbour graph. Scan detection uses the default 7x7 uint8 SSIM.
Keeping these narrow operations avoids shipping three scientific toolkits.
"""
import numpy as np
import cv2


class LineClusters:
    def __init__(self, eps, min_samples=1, metric="euclidean"):
        if eps <= 0 or min_samples != 1 or metric not in {"manhattan", "euclidean"}:
            raise ValueError("Unsupported line-clustering parameters")
        self.eps = eps
        self.metric = metric

    def fit(self, points):
        points = np.asarray(points, dtype=np.float64)
        labels = np.full(len(points), -1, dtype=int)
        label = 0
        for start in range(len(points)):
            if labels[start] >= 0:
                continue
            labels[start] = label
            pending = [start]
            while pending:
                delta = np.abs(points - points[pending.pop()])
                distances = delta.sum(axis=1) if self.metric == "manhattan" else np.sqrt((delta * delta).sum(axis=1))
                neighbours = np.flatnonzero((labels < 0) & (distances <= self.eps))
                labels[neighbours] = label
                pending.extend(neighbours.tolist())
            label += 1
        self.labels_ = labels
        return self


def structural_similarity(before, after):
    if before.dtype != np.uint8 or after.dtype != np.uint8 or before.shape != after.shape or before.ndim != 2:
        raise ValueError("Scan comparison expects equally sized uint8 grayscale images")
    x, y = before.astype(np.float64), after.astype(np.float64)

    def mean(image):
        vertical = cv2.boxFilter(image, -1, (1, 7), borderType=cv2.BORDER_REFLECT)
        return cv2.boxFilter(vertical, -1, (7, 1), borderType=cv2.BORDER_REFLECT)

    ux, uy = mean(x), mean(y)
    vx, vy = (mean(x * x) - ux * ux) * (49 / 48), (mean(y * y) - uy * uy) * (49 / 48)
    covariance = (mean(x * y) - ux * uy) * (49 / 48)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    score = ((2 * ux * uy + c1) * (2 * covariance + c2)) / ((ux * ux + uy * uy + c1) * (vx + vy + c2))
    return float(score[3:-3, 3:-3].mean())
