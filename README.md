# misub-proxy

MiSub 的 Fetch Proxy：部署在 Vercel 上的单文件 Serverless 代理（`api/index.js`），用于在非 Cloudflare 出口环境下替 MiSub 拉取机场订阅。

## 部署到 Vercel

1. 将本仓库推送到 GitHub，生产分支为 `main`。
2. Vercel Dashboard → **New Project** → Import Git Repository → 选择本仓库。
3. 在配置页按下表填写，**并在同一页完成环境变量配置**（否则部署后所有请求返回 503）：

| 配置项 | 取值 |
| --- | --- |
| Project Name | 自定，如 `misub-proxy` |
| Framework Preset | **Other** |
| Root Directory | `./`（仓库根，`api/` 才能被识别为函数） |
| Build Command | 留空 |
| Output Directory | 留空 |
| Environment Variables | 见下节 |

4. 点 **Deploy**，完成后生产域名形如 `https://misub-proxy.vercel.app`。

也可用 CLI 部署：`npx vercel deploy`（预览）、`npx vercel --prod`（生产）。

**分支行为**：push 到 `main` → 生产部署；其它分支或 PR → 预览部署。

**注意**：请使用**生产域名**。预览部署默认受 Deployment Protection（Vercel Authentication）保护，会返回登录页 HTML 而非订阅内容。

## 环境变量

在项目 Settings → Environment Variables 配置（导入向导中也可直接添加），作用域勾选 **Production + Preview**。

| 名称 | 必需 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `PROXY_TOKEN` | **是** | Secret | 无 | 访问令牌，未配置时所有请求返回 **503**。生成：`openssl rand -hex 24` |
| `UPSTREAM_TIMEOUT_MS` | 否 | Config | `10000` | 上游请求超时（毫秒） |
| `MAX_RESPONSE_BYTES` | 否 | Config | `5242880` | 上游响应体积上限（5 MiB） |

**生效规则**：环境变量变更**只对新部署生效**。修改后须重新部署：Deployments → 最新部署 → `⋯` → **Redeploy**（或再 push 一次提交）。

**访问方式**：令牌作为 `token` 参数传入，MiSub 订阅源的 Fetch Proxy 前缀填：

```
https://<域名>.vercel.app/api?token=<PROXY_TOKEN>&url=
```

令牌只存于 Vercel 环境变量，不要写入仓库。
