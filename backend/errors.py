"""Classify common failures into safe summaries without changing retry behavior."""
import errno
import re

# Stable public codes map to fixed messages; raw exception text never leaves this helper.
_MESSAGES = {
    "startup": ("本地引擎未能启动。", "请检查安装包是否匹配系统；本机版请选择同架构 Python 3.12，自带版可重新安装完整 XPI。原文和已有译文仍可阅读。"),
    "resource": ("本地资源不足或排版资源不可用。", "请检查磁盘空间、可用内存及安装包中的模型和字体；关闭不必要的程序，缺少资源时重新安装完整 XPI。"),
    "long_path": ("文件路径或文件名过长。", "请使用较短的缓存/数据目录或文件名后重试；无需修改系统长路径设置，也不要删除已有译文。"),
    "file_busy": ("文件被占用或无法访问。", "请关闭占用该文件的外部 PDF 阅读器，检查目录写权限及同步/杀毒软件后重试；不必删除原文或译文。"),
    "provider": ("服务商请求失败。", "请检查当前配置的 API 地址、模型、密钥及余额；限流或服务中断时稍后手动重试。请求可能已计费，不会因本提示自动重发。"),
    "general": ("操作未完成。", "请检查当前设置，必要时导出脱敏诊断包。失败不会删除已有译文；仍可阅读原文和已有译文，是否重试由你决定。"),
}


def explain_error(error):
    """Return {code, error, hint} using only fixed, credential-free public text."""
    text = str(error).lower()
    number = getattr(error, "errno", None)
    windows_number = getattr(error, "winerror", None)
    if number == errno.ENAMETOOLONG or windows_number == 206 or any(word in text for word in (
        "filename too long", "file name too long", "path too long", "max_path", "winerror 206", "路径过长", "路径太长")):
        code = "long_path"
    elif number in {errno.EBUSY, errno.ETXTBSY, errno.EACCES, errno.EPERM} or windows_number in {5, 32, 33} or any(word in text for word in (
        "permission denied", "access denied", "sharing violation", "being used by another process", "winerror 32", "winerror 33", "文件被占用")):
        code = "file_busy"
    elif isinstance(error, MemoryError) or number in {errno.ENOSPC, errno.ENOMEM} or windows_number in {8, 14, 112} or any(word in text for word in (
        "no space left", "disk full", "out of memory", "cannot allocate memory", "memoryerror",
        "not enough memory", "not enough storage", "缺少资源", "缺少模型", "模型文件", "font not found", "font file", "onnx", "tiktoken", "磁盘空间不足")):
        code = "resource"
    elif getattr(error, "status_code", None) in {401, 402, 403, 408, 429, 500, 502, 503, 504} or re.search(
        r"(?:http(?: status)?|error code|status code)\s*[:=]?\s*(?:401|402|403|408|429|500|502|503|504)\b", text
    ) or any(word in text for word in (
        "api key", "api_key", "authenticationerror", "rate limit", "ratelimit", "insufficient_quota",
        "connection error", "connectionerror", "apitimeouterror", "unauthorized", "service unavailable",
        "服务商", "余额不足", "限流", "模型不存在")):
        code = "provider"
    elif isinstance(error, (ImportError, SyntaxError)) or any(word in text for word in (
        "启动失败", "启动超时", "安装包", "python 3.12", "no module named", "dll load failed",
        "glibc_", "dyld", "cannot open shared object", "exec format error")):
        code = "startup"
    else:
        code = "general"
    message, hint = _MESSAGES[code]
    return {"code": code, "error": message, "hint": hint}
