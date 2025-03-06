const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');
const app = express();

const targetUrl = process.env.TARGET_URL || 'https://targetUrl.com';
// 提取目标URL的域名部分
const targetDomain = targetUrl.replace(/^https?:\/\//, '');

// 全面替换所有URL的函数
function replaceAllUrls(content, req) {
  const newBaseUrl = getNewBaseUrl(req);
  const targetUrlWithoutProtocol = targetUrl.replace(/^https?:\/\//, '');
  
  // 替换完整URL（http/https）
  content = content.replace(new RegExp(targetUrl, 'gi'), newBaseUrl);
  content = content.replace(new RegExp(targetUrl.replace('https://', 'http://'), 'gi'), newBaseUrl);
  
  // 替换https://到http://（针对不完整匹配的情况）
  content = content.replace(/https:\/\/(www\.johntitorblog\.com)/gi, `http://${req.headers.host}`);
  
  // 替换相对协议的URL（//domain.com形式）
  content = content.replace(new RegExp(`\/\/${targetDomain}`, 'gi'), `//${req.headers.host}`);
  
  // 替换WordPress常见的data-src属性中的URL
  content = content.replace(new RegExp(`data-src=["']https?:\/\/${targetDomain}`, 'gi'), `data-src="${newBaseUrl}`);
  
  // 替换CSS中的url()引用 
  content = content.replace(new RegExp(`url\\(['"]?https?:\/\/${targetDomain}`, 'gi'), `url(${newBaseUrl}`);
  
  // 替换任何形式的链接引用
  content = content.replace(new RegExp(`href=["']https?:\/\/${targetDomain}`, 'gi'), `href="${newBaseUrl}`);
  content = content.replace(new RegExp(`src=["']https?:\/\/${targetDomain}`, 'gi'), `src="${newBaseUrl}`);
  
  // 替换JSON数据中的URL
  content = content.replace(new RegExp(`["']https?:\/\/${targetDomain}([^"']*)["']`, 'gi'), `"${newBaseUrl}$1"`);
  
  // 替换WordPress加密文章中的表单提交URL
  if (content.includes('action=postpass') || content.includes('wp-login.php')) {
    content = content.replace(
      /form action=["'](https?:\/\/[^"']+)\/wp-login\.php([^"']*)["']/gi, 
      `form action="${newBaseUrl}/wp-login.php$2"`
    );
  }
  
  // 特殊处理WordPress的REST API URL
  content = content.replace(
    new RegExp(`["']${targetUrl}\\/wp-json\\/`, 'gi'), 
    `"${newBaseUrl}/wp-json/`
  );
  
  // 替换WordPress的admin-ajax.php请求
  content = content.replace(
    new RegExp(`["']${targetUrl}\\/wp-admin\\/admin-ajax\\.php`, 'gi'), 
    `"${newBaseUrl}/wp-admin/admin-ajax.php`
  );
  
  // 替换style属性中的背景图片URL
  content = content.replace(
    /style=["'][^"']*background-image:\s*url\s*\(\s*['"]?(https?:\/\/[^)"']+)['"]?\s*\)/gi,
    (match, url) => {
      if (url.includes(targetUrlWithoutProtocol)) {
        return match.replace(url, url.replace(/^https?:\/\/[^\/]+/, newBaseUrl));
      }
      return match;
    }
  );
  
  // 替换WordPress中常见的缩略图URL模式
  content = content.replace(
    /-\d+x\d+\.(jpg|jpeg|png|gif)/gi,
    (match) => match
  );
  
  // 确保开头没有@符号（修复用户提到的问题）
  content = content.replace(/@(http:\/\/[^\/]+)/gi, '$1');
  
  return content;
}

// 辅助函数：直接从请求中获取新的基础网址，改为使用http而非https
function getNewBaseUrl(req) {
  return `http://${req.headers.host}`;
}

function modifyResponseBody(proxyRes, req, res) {
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
          console.error('Gunzip error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        // 替换所有目标网址为新网址
        bodyText = replaceAllUrls(bodyText, req);
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩
        zlib.gzip(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            console.error('Gzip error:', err);
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
          console.error('Inflate error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        bodyText = replaceAllUrls(bodyText, req);
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩
        zlib.deflate(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            console.error('Deflate error:', err);
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
          console.error('Brotli Decompress error:', err);
          res.writeHead(proxyRes.statusCode, headers);
          return res.end(bodyBuffer);
        }
        let bodyText = decodedBuffer.toString('utf8');
        bodyText = replaceAllUrls(bodyText, req);
        let modifiedBuffer = Buffer.from(bodyText, 'utf8');
        // 再次压缩 Brotli
        zlib.brotliCompress(modifiedBuffer, (err, compressedBuffer) => {
          if (err) {
            console.error('Brotli Compress error:', err);
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
      bodyText = replaceAllUrls(bodyText, req);
      let modifiedBuffer = Buffer.from(bodyText, 'utf8');
      headers['content-length'] = Buffer.byteLength(modifiedBuffer);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(modifiedBuffer);
    }
  });

  proxyRes.on('error', (err) => {
    console.error('Proxy response error:', err);
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
    
    // 将WordPress密码保护表单的POST请求正确传递到目标服务器
    if (req.method === 'POST' && req.url.includes('action=postpass')) {
      console.log('处理加密文章密码提交...');
    }
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
        setCookie = setCookie.map(cookie => {
          // 移除domain属性
          let newCookie = cookie.replace(/;?\s*domain=[^;]+/i, '');
          // 移除secure标志，因为我们使用http
          newCookie = newCookie.replace(/;?\s*secure/i, '');
          // 如果有path属性，确保它是根路径，以便所有页面可以访问
          if (!newCookie.includes('path=')) {
            newCookie += '; path=/';
          }
          return newCookie;
        });
      }
      
      // 确保重定向URL使用正确的协议和主机名
      const redirectUrl = referer.replace(/^https?:\/\/[^\/]+/, getNewBaseUrl(req));
      
      const headers = {
        'Location': redirectUrl,
        'Content-Type': 'text/html'
      };
      if (setCookie) {
        headers['Set-Cookie'] = setCookie;
      }
      
      console.log('加密文章重定向到:', redirectUrl);
      
      res.writeHead(302, headers);
      res.end(`<html>
  <head>
    <meta http-equiv="refresh" content="0;url=${redirectUrl}">
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
        
        // 处理重定向头
        if (headers.location) {
          headers.location = headers.location.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
          // 确保使用http协议
          headers.location = headers.location.replace(/^https:/, 'http:');
        }
        
        // 处理Set-Cookie头
        if (headers['set-cookie']) {
          let setCookie = headers['set-cookie'];
          if (!Array.isArray(setCookie)) {
            setCookie = [setCookie];
          }
          headers['set-cookie'] = setCookie.map(cookie => {
            // 移除domain属性
            let newCookie = cookie.replace(/;?\s*domain=[^;]+/i, '');
            // 移除secure标志，因为我们使用http
            newCookie = newCookie.replace(/;?\s*secure/i, '');
            return newCookie;
          });
        }
        
        // 处理响应体
        let bodyText = bodyBuffer.toString('utf8');
        bodyText = replaceAllUrls(bodyText, req);
        const modifiedBuffer = Buffer.from(bodyText, 'utf8');
        
        res.writeHead(proxyRes.statusCode, headers);
        res.end(modifiedBuffer);
      });
    }
  }
}));

// 其他请求使用响应体修改，替换目标网址
app.use('/', createProxyMiddleware({
  target: targetUrl,
  changeOrigin: true,
  selfHandleResponse: true,
  // 设置代理标头，伪装成正常浏览器请求
  onProxyReq: (proxyReq, req, res) => {
    // 不压缩内容，方便处理
    proxyReq.setHeader('accept-encoding', 'identity');
    
    // 添加原始referer，如果有的话
    if (req.headers.referer) {
      const newReferer = req.headers.referer.replace(getNewBaseUrl(req), targetUrl);
      proxyReq.setHeader('referer', newReferer);
    }
    
    // 记录请求信息，便于调试
    console.log(`代理请求: ${req.method} ${req.url}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    // 记录响应状态
    console.log(`响应状态: ${proxyRes.statusCode} 对于 ${req.url}`);
    
    // 使用全局函数处理响应体修改
    modifyResponseBody(proxyRes, req, res);
  },
  // 处理代理错误
  onError: (err, req, res) => {
    console.error('代理错误:', err);
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end('代理服务器错误: ' + err.message);
  }
}));

// 如果不在 Vercel 环境中，则启动本地服务器
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3335;
  app.listen(PORT, () => {
    console.log(`----------------------------------------------------`);
    console.log(`WordPress 代理服务器已启动`);
    console.log(`----------------------------------------------------`);
    console.log(`目标WordPress站点: ${targetUrl}`);
    console.log(`本地代理地址: http://localhost:${PORT}`);
    console.log(`公网访问地址: http://172.233.49.235:${PORT}`);
    console.log(`支持IP+端口方式访问和完整链接替换`);
    console.log(`支持加密文章访问`);
    console.log(`----------------------------------------------------`);
  });
}

module.exports = app;
