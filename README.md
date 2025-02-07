# WP-JSProxy

该项目实现了一个基于 Node.js 的反向代理服务器，适合部署到 Vercel 之类的站点托管平台，用于反代指定的目标 WordPress 网站（理论上对单域名网站都有效），并自动将页面中所有返回的目标网址替换为当前访问的域名。

## 安装与运行

在本地使用 Vercel CLI 部署到 Vercel 。
或者，Fork 本项目到你自己的 Github ，再到 Vercel 控制台部署。
具体步骤可询问 ChatGPT 。
  
## 配置说明
  
  在 `server.js` 中定义目标网站地址，例如：
  ```js
  const targetUrl = process.env.TARGET_URL || 'https://targetUrl.com';
  ```
  表示所有反代请求均发往该地址。
  也可以到 Vercel 控制台添加环境变量 `TARGET_URL = https://newTargetUrl.com`
