const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');
const app = express();

// 移除body-parser中间件，避免干扰原始请求
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 简化日志
const debug = process.env.DEBUG === 'true';
function log(...args) {
  if (debug) console.log(...args);
}

// 添加CORS支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

const targetUrl = process.env.TARGET_URL || 'https://targetUrl.com';

// 获取当前请求的完整URL(含协议)
function getProxyHost(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return `${protocol}://${req.headers.host}`;
}

// 判断请求是否为API请求
function isApiRequest(req) {
  return (req.path.startsWith('/v1/') || req.path === '/v1' || req.path === '/');
}

// Grok API 反代处理
app.use('/v1', (req, res, next) => {
  if (isApiRequest(req)) {
    log(`处理API请求: ${req.path}`);
    
    const proxy = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: false,
      onProxyReq: (proxyReq, req, res) => {
        Object.keys(req.headers).forEach(key => {
          if (key !== 'host') {
            proxyReq.setHeader(key, req.headers[key]);
          }
        });
      },
      onError: (err, req, res) => {
        console.error(`API代理错误: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Proxy error', message: err.message });
        }
      }
    });
    
    return proxy(req, res, next);
  }
  
  next();
});

// 根路径处理
app.use('/', (req, res, next) => {
  if (req.path === '/') {
    const proxy = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: false
    });
    
    return proxy(req, res, next);
  }
  
  next();
});

// WordPress 反代处理 - 使用通用配置
const wpProxy = createProxyMiddleware({
  target: targetUrl,
  changeOrigin: true,
  selfHandleResponse: true,  // 重要：必须自行处理响应
  onProxyReq: (proxyReq, req, res) => {
    // 不压缩，以便于处理响应内容
    proxyReq.setHeader('accept-encoding', 'identity');
  },
  onProxyRes: (proxyRes, req, res) => {
    // 不处理API请求
    if (isApiRequest(req)) {
      return;
    }
    
    // 处理重定向头
    if (proxyRes.headers.location) {
      log(`重定向URL: ${proxyRes.headers.location} -> 替换为代理域名`);
      proxyRes.headers.location = proxyRes.headers.location.replace(targetUrl, getProxyHost(req));
    }
    
    // 处理Cookie
    if (proxyRes.headers['set-cookie']) {
      proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => {
        return cookie.replace(/domain=.*?;/gi, '');
      });
    }
    
    // 收集响应数据
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    
    proxyRes.on('end', () => {
      // 检查是否有数据
      if (!chunks.length) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        return res.end();
      }
      
      const buffer = Buffer.concat(chunks);
      
      // 检查内容类型，只处理文本内容
      const contentType = proxyRes.headers['content-type'] || '';
      const isTextContent = contentType.includes('text') || 
                            contentType.includes('javascript') || 
                            contentType.includes('json') || 
                            contentType.includes('xml') ||
                            contentType.includes('css');
      
      if (!isTextContent) {
        // 二进制内容直接传递
        const headers = {...proxyRes.headers};
        res.writeHead(proxyRes.statusCode, headers);
        return res.end(buffer);
      }
      
      // 处理文本内容，替换URL
      try {
        let body = buffer.toString('utf8');
        const proxyHost = getProxyHost(req);
        
        log(`处理响应内容: ${req.path}, 大小: ${body.length}, 类型: ${contentType}`);
        log(`将替换所有 ${targetUrl} 为 ${proxyHost}`);
        
        // 替换绝对URL
        body = body.replace(new RegExp(targetUrl.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), proxyHost);
        
        // 提取域名部分进行替换 (处理没有协议的URL)
        const targetDomain = new URL(targetUrl).hostname;
        body = body.replace(new RegExp(`//(?:www\\.)?${targetDomain.replace(/\./g, '\\.')}`, 'g'), 
                           `//${req.headers.host}`);
        
        // 替换HTML属性中的链接
        ['href', 'src', 'action'].forEach(attr => {
          const pattern = new RegExp(`(${attr}=["'])(?:https?:)?//${targetDomain.replace(/\./g, '\\.')}([^"']*)`, 'g');
          body = body.replace(pattern, `$1${proxyHost}$2`);
        });
        
        // 替换JSON字符串中的URL
        body = body.replace(new RegExp(`"(https?:)?//${targetDomain.replace(/\./g, '\\.')}/`, 'g'), 
                           `"${proxyHost}/`);
        
        // 设置正确的头部
        const headers = {...proxyRes.headers};
        delete headers['content-length'];
        headers['content-length'] = Buffer.byteLength(body);
        
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      } catch (error) {
        console.error('处理响应时出错:', error);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(buffer);
      }
    });
  }
});

// 应用WordPress代理到所有其他路径
app.use('/', wpProxy);

// 启动本地服务器 (非Vercel环境)
if (!process.env.VERCEL) {
  app.listen(3000, () => {
    log('代理服务器运行在 http://localhost:3000');
  });
}

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.stack);
  
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(500).json({
    error: '服务器内部错误',
    message: debug ? err.message : '发生错误，请稍后再试'
  });
});

module.exports = app;
