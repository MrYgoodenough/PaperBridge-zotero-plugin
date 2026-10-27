"""Translate exactly one public reference page, using a user-supplied local test key."""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
key_path = ROOT / ".runtime/deepseek.key"
values = {}
env_path = ROOT / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.removeprefix("export ").split("=", 1)
            values[name.strip()] = value.strip().strip("\"'")
key = values.get("DEEPSEEK_API_KEY") or values.get("OPENAI_API_KEY") or values.get("API_KEY") or values.get("key")
key = key or (key_path.read_text().strip() if key_path.exists() else "")
if not key:
    raise SystemExit("尚未填写短期 Key；请在本地密钥文件中填写并保存。")
token = (ROOT / ".runtime/token").read_text().strip()
port=json.loads((ROOT / ".runtime/service.json").read_text())["port"]


def call(path, data=None):
    request = urllib.request.Request(f"http://127.0.0.1:{port}" + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization":"Bearer " + token, "Content-Type":"application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


source = ROOT / ".cache/references/pi0-v3.pdf"
job = call("/jobs", {"source_path":str(source), "api_key":key,
                     "model":values.get("DEEPSEEK_MODEL", "deepseek-flash"),
                     "base_url":values.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
                     "lang_out":"zh-CN", "pages":"2-4"})
del key
last = ""
while job["state"] not in {"done", "failed", "cancelled"}:
    stage = f"{job['progress']:.0f}% {job['stage']}"
    if stage != last:
        print(stage, flush=True)
        last = stage
    time.sleep(2)
    job = call("/jobs/" + job["id"])
(ROOT / ".runtime/deepseek-result.json").write_text(json.dumps(job, ensure_ascii=False, indent=2))
if job["state"] != "done":
    raise SystemExit(job["error"] or job["stage"])
print("真实 DeepSeek 第 2–4 页翻译完成：" + job["output_path"], flush=True)
