"""Persist actual provider cache usage, without storing prompts or credentials."""
import json
import threading

from babeldoc.translator.translator import OpenAITranslator


class MeteredTranslator(OpenAITranslator):
    def __init__(self, usage_path, **kwargs):
        super().__init__(**kwargs)
        self.usage_path = usage_path
        self.usage_lock = threading.Lock()
        self.requests = []
        self.paragraph_cache_hits = 0
        self.request_context = threading.local()

    def update_token_count(self, response):
        super().update_token_count(response)
        usage = response.usage
        if usage is None:
            return
        hit = getattr(usage, "prompt_cache_hit_tokens", None)
        if hit is None:
            hit = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0)
        prompt = int(usage.prompt_tokens or 0)
        hit = int(hit or 0)
        miss = int(getattr(usage, "prompt_cache_miss_tokens", prompt - hit) or 0)
        with self.usage_lock:
            self.requests.append({"prompt_tokens": prompt, "prompt_cache_hit_tokens": hit,
                "prompt_cache_miss_tokens": miss, "completion_tokens": int(usage.completion_tokens or 0),
                "request_id":getattr(response,"id",None),
                **getattr(self.request_context,"metadata",{})})
            self.write_usage()

    def write_usage(self, **extra):
        report = {"model": self.model, "api_requests": len(self.requests),
                  "input_tokens": sum(r["prompt_tokens"] for r in self.requests),
                  "cached_input_tokens": sum(r["prompt_cache_hit_tokens"] for r in self.requests),
                  "uncached_input_tokens": sum(r["prompt_cache_miss_tokens"] for r in self.requests),
                  "output_tokens": sum(r["completion_tokens"] for r in self.requests),
                  "local_cache_hits": self.translate_cache_call_count,
                  "paragraph_cache_hits":self.paragraph_cache_hits, "requests": self.requests, **extra}
        temporary = self.usage_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2))
        temporary.replace(self.usage_path)
