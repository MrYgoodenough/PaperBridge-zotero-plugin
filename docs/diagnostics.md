# 错误提示与脱敏诊断

本功能只分类和解释错误，不建立异常框架，不修改任务状态、自动重试或删除成果。导出失败只使本次诊断导出失效，不影响原文及已有译文阅读。

## 后端契约

`backend/errors.py`（服务脚本中 `from errors import explain_error`）：

```python
explain_error(error) -> {"code": str, "error": str, "hint": str}
```

接受异常或错误字符串；`code` 只取 `startup`（启动）、`resource`（资源）、`long_path`（长路径）、`file_busy`（占用/权限）、`provider`（服务商）、`general`（普通错误）。`error` 和 `hint` 是固定中文安全文本，不回显原始异常、凭据、路径或服务商响应。优先识别 errno/winerror，其余采用少量常见关键词；未知情况归为普通错误，不拒绝其他功能。

主程序可将这三个字段合并进 HTTP 错误响应和失败任务的公开视图。前端请求异常需要保留 `code` / `hint`，并展示 `hint`；任务卡片由主代理接入，不能因此隐式重试。不要把这份固定摘要替代成原始 stderr。

`backend/diagnostics.py`（服务脚本中 `from diagnostics import create_bundle`）：

```python
create_bundle(store_or_jobs, state_root) -> pathlib.Path
```

- 接受现有 `JobStore`（调用一次 `list_jobs()`），也支持 `list()` 返回 public job 列表的 store、直接列表/元组或 `{"jobs": [...], "warning_count": N}`。列表元素读取 `state` 和 `quality.status`，不修改输入；store 列表自身可能按原实现刷新用量，但导出器不会扫描任务目录。
- 传入 store 时，只对 `load_warnings` 列表/元组取 `len()`，不读取警告文本。返回 ZIP 的 `safety.warning_count` 为该整数；传入包装对象时采用其非负整数 `warning_count`。单独列表或未提供计数时为 `null`，表示未知而非零警告。推荐服务直接传 `self.server.store`。
- `state_root` 为服务实际状态目录。返回文件位于其 `diagnostics/` 下；每次用独占创建的随机文件名输出，不覆盖旧包。POSIX 新 ZIP 为 `0600`，Windows 沿用用户目录权限，不更改系统权限策略。
- 正常返回才代表 ZIP 写入完成；磁盘/权限等错误直接抛出，由现有 HTTP 捕获处理。失败的新包会清理，旧包保留。

`backend/server.py::Handler.dispatch()` 已在 host/origin/token 鉴权之后接入路由：

```python
# Inside Handler.dispatch(), after the existing host/origin/token checks.
if self.command == "POST" and path == "/diagnostics":
    self.body()
    bundle = create_bundle(self.server.store, RUNTIME)
    return self.respond(200, {"path": str(bundle)})
```

对外契约：鉴权 `POST /diagnostics`，请求 `{}`，成功响应 `{"path": "本地 ZIP 的绝对路径"}`。响应路径只用于本地显示/定位，不写入 ZIP。禁止开放未鉴权的导出或文件下载接口。

## ZIP allowlist

唯一成员为 `diagnostics.json`，只含：

- `schema_version: 1`。
- `versions`：PaperBridge、Python、BabelDOC、PyMuPDF 的规范版本号；无可验证版本时为 `unknown`。只读固定的应用版本元数据与已安装包版本，不读配置/凭据。
- `platform`：`linux/windows/macos/other` 及 `x64/arm64/other`；无主机名、系统用户名、详细系统构建或解释器路径。
- `tasks`：总数、固定状态计数、固定完整性状态计数；未知状态统一归入 `unknown`。不含任务 ID、标题、文件名、配置、时间、文本、错误详情或用量。
- `safety`：明确 `allowlist_only`，凭据、文档内容、用户路径、原始日志均未包含；`warning_count` 只表示损坏记录保留/忽略的数量，不含 `load_warnings` 文本。该字段描述**导出范围**及记录加载提醒，不是对运行环境安全性的扫描或认证。

不压缩整目录，不读 token、API Key、PDF、译文、论文文本、用户 profile、原始 stderr、日志或凭据库，也不采集环境变量。ZIP 留在本机，无自动上传。导出器的 allowlist 构造位于 `_summary()`；扩展时仍只允许固定枚举、版本和计数，不能复制公共 job 全体字段。

## 设置与启动提示

设置页的「脱敏诊断包」提供导出与「打开文件位置」。导出只执行 `bridge.request('/diagnostics', 'POST', {})`，不保存配置、不发送设置草稿或服务商密钥。文件定位失败时仍显示可复制路径，ZIP 保留。

「保存并检查引擎」读取 `/health` 的非负整数 `warning_count`；大于零时附加非致命提醒，明确原记录保留、引擎仍可用，不展示原始警告路径，也不阻止保存和阅读。旧服务未提供该字段时继续原有检查。

引擎尚未启动时无法通过该接口导出，设置页明确说明此限制。`runtime.js` 本地识别启动、资源、长路径和文件占用，展示可操作提示而不回显原始子进程输出；不新增平台拒绝条件，也不影响已有阅读功能。不能把本功能当作启动崩溃日志采集器。

隔离测试：使用项目 `.venv` 执行 `python -m pytest tests/test_diagnostics.py tests/test_errors.py`；仅使用临时元数据、伪凭据和伪 PDF，不接触真实 profile 或模型接口。
