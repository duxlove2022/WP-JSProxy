# WP-JSProxy

该项目实现了一个基于 Node.js 的反向代理服务器，用于反代指定的目标 WordPress 网站（理论上对单域名网站都有效），并自动将页面中所有返回的目标网址替换为当前访问的域名。

## 安装与运行

### 部署到 Vercel

- **预览版部署**：在终端运行
  ```bash
  vercel
  ```
  系统将生成一个预览网址供你测试。

- **生产版部署**：在终端运行
  ```bash
  vercel --prod
  ```
  
## 配置说明

- **目标网址 (targetUrl)**  
  在 `server.js` 中定义了目标网站地址，例如：
  ```js
  const targetUrl = 'https://targetUrl.com';
  ```
  表示所有反代请求均发往该地址。

- **自动替换域名**  
  辅助函数 `getNewBaseUrl(req)` 会从请求头中获取当前访问域名，然后将页面内容中所有的目标网址（targetUrl）替换为该域名。这样即使你以后切换域名，页面中的链接也会自动调整为当前访问域名。

- **特殊路径处理**  
  对于 `/wp-login.php?action=postpass` 的请求，代码会特殊处理 Cookie 和重定向，以确保经过密码验证的页面能正常显示。

## 项目结构
.
├── server.js // 反向代理核心代码
├── package.json // 项目基本信息及依赖列表
├── package-lock.json // 锁定依赖版本（如果存在）
├── vercel.json // Vercel 部署配置（如果使用 Vercel 部署）
├── .gitignore // Git 忽略文件配置
└── README.md // 说明文档