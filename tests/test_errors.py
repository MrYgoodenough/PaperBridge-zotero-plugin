"""Check minimal error categories and fixed, non-sensitive user guidance."""
import errno
import json

import pytest

from backend.errors import explain_error


@pytest.mark.parametrize(("error", "code"), [
    (ImportError("No module named ssl"), "startup"),
    ("内置引擎启动超时", "startup"),
    ("GLIBC_2.34 not found", "startup"),
    (MemoryError("private text"), "resource"),
    (OSError(errno.ENOSPC, "private disk"), "resource"),
    ("missing doclayout.onnx", "resource"),
    (OSError(errno.ENAMETOOLONG, "private filename"), "long_path"),
    ("[WinError 206] filename too long", "long_path"),
    (OSError(errno.EBUSY, "private PDF"), "file_busy"),
    (PermissionError(errno.EACCES, "private directory"), "file_busy"),
    ("[WinError 32] being used by another process", "file_busy"),
    ("Rate limit: API Key fixture", "provider"),
    ("余额不足", "provider"),
    ("HTTP 503", "provider"),
    ("Error code: 429", "provider"),
    ("unrecognized exception", "general"),
    (None, "general"),
])
def test_categories(error, code):
    """Cover POSIX, Windows, runtime, provider, and ordinary failures."""
    result = explain_error(error)
    assert set(result) == {"code", "error", "hint"}
    assert result["code"] == code
    assert result["error"] and result["hint"]


def test_structured_provider_status():
    """Recognize SDK status codes without importing an SDK or reading credentials."""
    error = RuntimeError("synthetic provider failure")
    error.status_code = 429
    assert explain_error(error)["code"] == "provider"


def test_windows_error_number():
    """Classify a Windows error object even when its message is localized."""
    error = OSError("synthetic message")
    error.winerror = 206
    assert explain_error(error)["code"] == "long_path"
    error.winerror = 112
    assert explain_error(error)["code"] == "resource"


def test_no_raw_error_leaves_helper():
    """Do not echo credentials, paths, PDF content, or provider response bodies."""
    private = "sk-fixture-only Bearer fixture-token /home/private/paper.pdf C:\\Users\\private\\paper.pdf 论文秘密正文"
    for prefix in ("No module named ", "out of memory ", "filename too long ", "permission denied ", "API Key ", "unexpected "):
        result = explain_error(prefix + private)
        encoded = json.dumps(result, ensure_ascii=False)
        for fragment in ("sk-fixture-only", "fixture-token", "/home/private", "C:\\Users", "论文秘密正文"):
            assert fragment not in encoded
    assert "不会" in explain_error("Rate limit")["hint"]
