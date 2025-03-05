const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');
const app = express();

// 添加body-parser中间件解析JSON请求体
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 日志级别控制
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug', 'info', 'warn', 'error'
const logger = {
  debug: (...args) => LOG_LEVEL === 'debug' && console.debug(...args),
  info: (...args) => ['debug', 'info'].includes(LOG_LEVEL) && console.log(...args),
  warn: (...args) => ['debug', 'info', 'warn'].includes(LOG_LEVEL) && console.warn(...args),
  error: (...args) => console.error(...args)
};

const targetUrl = process.env.TARGET_URL || 'https://targetUrl.com';

// 辅助函数：直接从请求中获取新的基础网址
function getNewBaseUrl(req) {
  return `https://${req.headers.host}`;
}

// 判断请求是否为Grok API请求
function isGrokApiRequest(req) {
  // 检查请求路径或其他特征以识别Grok API请求
  if (!req.path.startsWith('/v1')) {
    return false;
  }
  
  // 常见的AI API端点
  const apiEndpoints = [
    '/chat/completions',
    '/completions',
    '/generations',
    '/models',
    '/images/generations',
    '/embeddings',
    '/assistants',
    '/threads',
    '/runs'
  ];
  
  // 检查是否包含任何已知API端点
  return apiEndpoints.some(endpoint => req.path.includes(endpoint)) || 
         // 备用检查：检查内容类型和accept头
         (req.headers['content-type']?.includes('application/json') && 
          req.headers['accept']?.includes('text/event-stream'));
}

// 为Grok API请求创建专门的代理中间件，支持流式响应
// 注意：此中间件必须在一般处理中间件之前定义，以确保优先处理API请求
app.use('/v1', (req, res, next) => {
  // 只处理Grok API请求，其他请求传递给下一个中间件
  if (!isGrokApiRequest(req)) {
    return next();
  }
  
  logger.info(`[Grok API] 处理API请求: ${req.path}`);
  
  // 使用相同的targetUrl，但是配置不同
  const proxy = createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    // 关键：不自行处理响应，直接传递流
    selfHandleResponse: false,
    // 保留原始请求头，允许压缩
    onProxyReq: (proxyReq, req, res) => {
      // 保留原始请求头
      Object.keys(req.headers).forEach(key => {
        // 除了host头，其他都原样传递
        if (key !== 'host') {
          proxyReq.setHeader(key, req.headers[key]);
        }
      });
      
      // 保留原始请求体
      if (req.body) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    },
    // 添加错误处理
    onError: (err, req, res) => {
      logger.error(`[Grok API] 代理错误: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
      }
    },
    // 记录代理响应信息
    onProxyRes: (proxyRes, req, res) => {
      // 只记录，不修改响应
      logger.info(`[Grok API] 响应状态: ${proxyRes.statusCode}, 内容类型: ${proxyRes.headers['content-type'] || '未知'}`);
    }
  });
  
  proxy(req, res, next);
});

function modifyResponseBody(proxyRes, req, res) {
  // 如果是Grok API请求，不应该走到这里
  if (isGrokApiRequest(req)) {
    logger.warn('[WordPress] Grok API请求被错误地由WordPress处理器处理');
    return;
  }
  
  const chunks = [];
  // 收集响应数据块
  proxyRes.on('data', (chunk) => {
    chunks.push(chunk);
  });

  proxyRes.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    // 复制响应头，后续会修改
    const headers = Object.assign({}, proxyRes.headers);
    // 更新 location 头（重定向链接）中的网址
    if (headers.location) {
      headers.location = headers.location.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
    }
    // 删除 content-length，因为替换后可能会改变数据长度
    delete headers['content-length'];

    // 检查内容类型，只对文本类型内容进行替换，防止修改二进制数据（如图片）
    const contentType = headers['content-type'] || '';
    const isText = contentType.includes('text') ||
                   contentType.includes('json') ||
                   contentType.includes('xml') ||
                   contentType.includes('javascript') ||
                   contentType.includes('css');
    if (!isText) {
      res.writeHead(proxyRes.statusCode, headers);
      return res.end(bodyBuffer);
    }

    const encoding = headers['content-encoding'];
    if (encoding === 'gzip') {
      // 处理 gzip 编码
      zlib.gunzip(bodyBuffer, (err, decodedBuffer) => {
        if (err) {
          logger.error('Gunzip error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        // 替换所有目标网址为新网址
        bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩
        zlib.gzip(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            logger.error('Gzip error:', err);
            res.writeHead(proxyRes.statusCode, headers);
            return res.end(modifiedBuffer);
          }
          headers['content-length'] = Buffer.byteLength(compressedBuffer);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(compressedBuffer);
        });
      });
    } else if (encoding === 'deflate') {
      // 处理 deflate 编码
      zlib.inflate(bodyBuffer, (err, decodedBuffer) => {
        if (err) {
          logger.error('Inflate error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩
        zlib.deflate(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            logger.error('Deflate error:', err);
            res.writeHead(proxyRes.statusCode, headers);
            return res.end(modifiedBuffer);
          }
          headers['content-length'] = Buffer.byteLength(compressedBuffer);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(compressedBuffer);
        });
      });
    } else if (encoding === 'br') {
      // 处理 Brotli (br) 编码
      zlib.brotliDecompress(bodyBuffer, (err, decodedBuffer) => {
        if (err) {
          logger.error('Brotli Decompress error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩 Brotli
        zlib.brotliCompress(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            logger.error('Brotli Compress error:', err);
            res.writeHead(proxyRes.statusCode, headers);
            return res.end(modifiedBuffer);
          }
          headers['content-length'] = Buffer.byteLength(compressedBuffer);
          res.writeHead(proxyRes.statusCode, headers);
          res.end(compressedBuffer);
        });
      });
    } else {
      // 未压缩的内容或不支持的编码
      let bodyText = bodyBuffer.toString('utf8');
      bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
      let modifiedBuffer = Buffer.from(bodyText, 'utf8');
      headers['content-length'] = Buffer.byteLength(modifiedBuffer);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(modifiedBuffer);
    }
  });

  proxyRes.on('error', (err) => {
    logger.error('Proxy response error:', err);
    res.end();
  });
}

// 单独处理 wp-login.php 请求，针对 action=postpass 进行特殊处理，避免空白页面问题
app.use('/wp-login.php', createProxyMiddleware({
  target: targetUrl,
  changeOrigin: true,
  selfHandleResponse: true,
  // 强制请求不使用压缩编码
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('accept-encoding', 'identity');
  },
  onProxyRes: (proxyRes, req, res) => {
    if (req.url.includes('action=postpass')) {
      // 当请求中包含 action=postpass 时，从后端获取 Set-Cookie，
      // 将 cookie 中的 domain 属性去掉（或修改为新域），再返回302重定向到原始页面
      const referer = req.headers.referer || getNewBaseUrl(req);
      let setCookie = proxyRes.headers['set-cookie'];
      if (setCookie) {
        if (!Array.isArray(setCookie)) {
          setCookie = [setCookie];
        }
        // 去除 cookie 中的 domain 属性，确保 cookie 默认作用于当前域
        setCookie = setCookie.map(cookie => cookie.replace(/;?\s*domain=[^;]+/i, ''));
      }
      const headers = {
        'Location': referer,
        'Content-Type': 'text/html'
      };
      if (setCookie) {
        headers['Set-Cookie'] = setCookie;
      }
      res.writeHead(302, headers);
      res.end(`<html>
  <head>
    <meta http-equiv="refresh" content="0;url=${referer}">
  </head>
  <body>验证成功，正在重定向...</body>
</html>`);
    } else {
      // 对于其他情况，直接转发响应数据，并修正 location 头中的目标网址
      let chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const headers = Object.assign({}, proxyRes.headers);
        if (headers.location) {
          headers.location = headers.location.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
        }
        res.writeHead(proxyRes.statusCode, headers);
        res.end(bodyBuffer);
      });
    }
  }
}));

// 其他请求使用响应体修改，替换目标网址
app.use('/', createProxyMiddleware({
  target: targetUrl,
  changeOrigin: true,
  selfHandleResponse: true,
  // 强制请求不使用压缩编码
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('accept-encoding', 'identity');
  },
  onProxyRes: modifyResponseBody
}));

// 如果不在 Vercel 环境中，则启动本地服务器
if (!process.env.VERCEL) {
  app.listen(3000, () => {
    logger.info('Proxy server is running on http://localhost:3000');
  });
}

// 全局错误处理中间件，必须在所有路由之后定义
app.use((err, req, res, next) => {
  logger.error('服务器错误:', err.stack);
  
  // 检查是否已经发送了头部
  if (res.headersSent) {
    return next(err);
  }
  
  // 发送错误响应
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? '服务器发生错误' : err.message
  });
});

module.exports = app;
