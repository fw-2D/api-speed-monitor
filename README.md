# 青测 · AI API 测速与稳定性

一个浅绿磨砂风格的网页工具。每位使用者填入自己的 API 地址和密钥，即可拉取模型、检测接口兼容性、查看流式首字延迟、输出速度与周期监控结果。

**[在线使用青测](https://qingce-api-monitor.netlify.app/)** · 无需注册，填写自己的 API 地址和密钥即可使用。

## 项目代码

| 文件 | 用途 |
| --- | --- |
| `outputs/api-speed-monitor/index.html` | 单页布局与表单 |
| `outputs/api-speed-monitor/assets/styles.css` | 浅色界面与响应式布局 |
| `outputs/api-speed-monitor/assets/ui.js` | 面板过渡、粒子与示例预览 |
| `outputs/api-speed-monitor/assets/monitor.js` | 模型检测、测速与本机历史 |
| `outputs/api-speed-monitor/netlify/functions/relay.mjs` | 公网 API 的同源流式转发 |
| `netlify.toml` | Netlify 发布目录、函数路由与响应头 |
| `scripts/dev-server.mjs` | 不依赖额外包的本地预览与转发服务 |

## 部署与使用

在 Netlify 选择 **Import an existing project → GitHub → fw-2D/api-speed-monitor**。仓库内的 `netlify.toml` 已指定发布目录和函数目录，无需构建命令。部署后的根网址即可分享给其他人，使用者不需要 GitHub 或 Netlify 账号。

首次部署后，在项目概览点击 **Make public**，访问范围选择 **Public**；否则生产网页可能要求访问者先登录。本站的生产网址已设为公开，部署预览仍可保持团队私有。

完整配置、指标口径和隐私说明见 [使用文档](outputs/api-speed-monitor/README.md)。

默认使用 `/v1/responses`。网站转发会经过本网站服务器处理使用者填入的密钥，不持久保存密钥；浏览器直连则需要目标中转站允许跨域。周期监控需要保持网页打开，真实测试会消耗使用者自己的 API 额度。
