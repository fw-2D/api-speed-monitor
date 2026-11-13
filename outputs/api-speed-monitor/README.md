# AI API 长期测速监控

一个零依赖的单文件网页，用于长期监控 OpenAI 兼容中转站的模型响应速度和稳定性。界面采用 GitHub Dark 绿色系风格。

## 功能

- 支持任意 OpenAI 兼容 Base URL 和 API Key。
- 一键拉取 `/v1/models`，或手动维护模型列表。
- 单模型深度检测：是否出现在模型列表、Responses 协议状态、流式是否收到完成事件、输出内容、响应 model 是否一致，并支持复制检测报告。
- 周期性调用流式 `/v1/responses`，记录：
  - TTFT（首 token 时间）
  - 总耗时
  - 输出 tokens
  - tokens/s
  - HTTP 错误、超时和流中断
- 展示成功率、中位数指标、TTFT 趋势图、输出速度趋势图、逐模型状态表。
- 历史数据保存在浏览器 localStorage，可导出/导入 JSON 备份。

## 分享给别人

最简单的方式：把 `api-speed-monitor.zip` 发给对方，解压后双击 `index.html`。

网页不会内置你的 API Key、Base URL 或历史数据；对方打开后填写自己的配置即可使用。

也可以把 `index.html` 单独发给对方，`README.md` 只是说明文档，不是运行依赖。

## 启动

直接双击 `index.html` 即可使用。也可以用本地静态服务启动：

```powershell
python -m http.server 8787 --directory .\outputs\api-speed-monitor
```

然后访问 <http://localhost:8787>。

## 推荐配置

- **监控间隔**：30–60 分钟。过密会消耗大量额度并触发限流。
- **最大输出 tokens**：128–256，足够计算 tokens/s，成本又较低。
- **推理强度**：先用 `medium` 做基线；测试 `max` 会显著增加耗时和额度消耗。
- **API Key**：默认只在当前页面会话中使用；勾选保存才会写入本机 localStorage。

## 数据边界

页面必须保持打开才会持续测试。若中转站没有配置 CORS，浏览器会拦截请求；这属于中转站安全策略，不是本页面故障。

## 与现有项目对比

- [Uptime Kuma](https://github.com/louislam/uptime-kuma)：成熟的自托管监控面板，适合通用 HTTP/站点可用性，但默认指标偏 HTTP 延迟，缺少 LLM 的 TTFT 和 tokens/s。
- [llmapibenchmark](https://github.com/Yoosu-L/llmapibenchmark)：命令行基准工具，适合压测和报告，不适合长期开着看趋势。
- [openai-llm-benchmark](https://github.com/robert-mcdermott/openai-llm-benchmark)：并发基准工具，偏一次性测试。
- 本项目专注你的场景：中转站模型可用性、首 token 延迟、输出速度、断流率和长期趋势。
