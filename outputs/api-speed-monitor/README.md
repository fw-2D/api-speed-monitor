# 青测 · AI API 测速与稳定性

一个静态网页加一个 Netlify 同源转发函数，用于监控 OpenAI 兼容中转站的模型响应速度和稳定性。界面采用浅绿磨砂风格，控制区在一页内完成，选项切换带过渡动效，背景有轻量粒子特效。页面支持浏览器直连和同源转发两种方式。

## 功能

- 支持任意 OpenAI 兼容 Base URL 和 API Key。
- 一键拉取 `/v1/models`，或手动维护模型列表。
- 单模型深度检测：是否出现在模型列表、协议状态、流式是否收到完成事件、输出内容、响应 model 是否一致，并支持复制检测报告。
- 周期性调用流式 `/v1/responses`，记录 TTFT、总耗时、输出 tokens、tokens/s、HTTP 错误、超时和流中断。
- 展示成功率、中位数指标、TTFT 趋势图、输出速度趋势图和逐模型状态表。
- 历史数据保存在浏览器 localStorage，可导出/导入 JSON 备份。
- 支持直接请求中转站；部署到 Netlify 后，同源 `/api/relay` 会转发 `models`、`responses`、`chat/completions` 和 `messages`。

## 在线部署

仓库根目录的 `netlify.toml` 已配置 Netlify 的发布目录为 `outputs/api-speed-monitor`，函数目录为该目录下的 `netlify/functions`。在 Netlify 导入 GitHub 仓库后，使用默认构建设置即可，不需要额外安装依赖。

部署后，Netlify 会把 `/api/relay` 映射到转发函数。网页放在 Netlify 域名下时，可选择同源转发；本地双击 `index.html` 时，请求直接发到用户填写的中转站。

页面 CSP 的 `connect-src` 允许 `https:`，因此浏览器直连不会被安全策略拦截。所有脚本都是外部文件，CSP 不再允许内联脚本。

转发函数只接受同源页面发起的 POST，并检查 `Sec-Fetch-Site`。它校验 HTTPS 公网域名、443 端口、DNS 公网解析、请求大小、endpoint 白名单和重建后的请求体。`responses` 只允许模型、输入、token 上限、流式和 `reasoning.effort`；`chat/completions` 与 `messages` 只允许模型、token 上限、流式和一条用户消息。函数固定使用同一次 DNS 解析结果发起连接，减少 DNS rebinding 风险，并且不转发 Cookie 或浏览器凭据。认证头按 endpoint 生成：`responses` 和 `chat/completions` 使用 `Authorization: Bearer`，`messages` 使用 `x-api-key` 和 `anthropic-version`。流式响应按 HTTP Response 透传，保持 SSE 逐块输出，TTFT 仍能反映上游首字节到达时间。上游结束或用户取消时会销毁上游请求并释放活动计数。

Netlify Functions v2 返回流式 `Response` 时支持流式响应。[Netlify 官方文档](https://docs.netlify.com/build/functions/api)列出流式函数执行时间上限为 60 秒，响应体上限为 20 MB；转发函数给上游预留约 55 秒，以便在平台终止前清理连接。长回复或上游很慢时可切换浏览器直连，前提是中转站允许 CORS。

函数内置每个实例的 best-effort 限流：单个客户端标识每分钟约 30 次，活动请求约 2 个。这些计数保存在函数进程内存中，多个 Netlify 实例之间不共享，重启后会清零，所以不能作为严格的全局防护。

## 启动

在仓库根目录使用 Node.js 22 或更新版本启动，网页和同源转发都可以在本地使用：

```powershell
node scripts/dev-server.mjs
```

然后访问 <http://localhost:8787>。无需安装前端依赖。

也可以直接打开 `outputs/api-speed-monitor/index.html`，页面会默认使用浏览器直连；这种方式需要目标中转站允许跨域。

## 推荐配置

- **监控间隔**：30–60 分钟。过密会消耗大量额度并触发限流。
- **最大输出 tokens**：128–256，足够计算 tokens/s，成本又较低。
- **推理强度**：默认不指定，跟随上游模型默认配置；更高档位可能增加首字等待和额度消耗。
- **模型能力**：推理强度档位是否可用由上游模型和中转站决定，页面不会把不可用档位当作模型名称错误。

## 隐私与数据边界

API Key 默认只在当前页面会话中使用；显式勾选“记住密钥”才会写入本机 localStorage，取消勾选会移除本机保存的密钥。转发函数会在内存中接收密钥并转发到使用者填写的中转站，不把密钥写入日志或持久存储。导出 JSON 不包含 API Key。示例预览使用单独的模拟数据，不会覆盖真实历史或发起 API 请求。

页面必须保持打开才会持续测试。浏览器后台休眠或关闭页面会暂停定时测试，这不是离线运行的监控服务。

直连测得的是从浏览器发起请求到上游响应返回的耗时；转发模式还包括浏览器与 Netlify 的网络、函数冷启动、域名解析以及函数到中转站的路由时间。TTFT 是从请求开始到首个非空文本事件之间的秒数。只有收到明确完成事件且有文本输出，才计为成功；非流式 JSON 可以检测，但不算流式测速成功。

tokens/s 使用 API 返回的输出 tokens 除以首个文本事件之后的输出耗时。如 API 单独报告 reasoning tokens，会在速度计算中扣除；若 API 未返回用量则显示“—”，不按字符数猜测 token 数。模型标识一致性仅核对返回 ID，不能证明底层模型真实性。

默认协议为 Responses，GPT-6 Astra 和 GPT-6.1 Sol 的相关模型 ID 固定走 Responses；其他模型可以显式选择 Chat Completions 或 Anthropic Messages，也可以让自动模式按模型 ID 选择。推理强度选项由上游验证，页面不保证每个模型都接受全部档位。

部署后可访问 `/.netlify/functions/health` 检查站点的流式传输；该接口只发出三条站点状态事件，不使用模型或 API Key。

## 与现有项目对比

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)：成熟的自托管监控面板，适合通用 HTTP/站点可用性，但默认指标偏 HTTP 延迟，缺少 LLM 的 TTFT 和 tokens/s。
- [llmapibenchmark](https://github.com/Yoosu-L/llmapibenchmark)：命令行基准工具，适合压测和报告，不适合长期开着看趋势。
- [openai-llm-benchmark](https://github.com/robert-mcdermott/openai-llm-benchmark)：并发基准工具，偏一次性测试。
- 本项目专注你的场景：中转站模型可用性、首 token 延迟、输出速度、断流率和长期趋势。
