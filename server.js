const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');
const app = express();

const targetUrl = process.env.TARGET_URL || 'https://targetUrl.com';

// 辅助函数：直接从请求中获取新的基础网址
function getNewBaseUrl(req) {
    return `https://${req.headers.host}`;
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
        const isText = contentType.includes('text') || contentType.includes('json') ||
                       contentType.includes('xml') || contentType.includes('javascript') ||
                       contentType.includes('css');
        if (!isText) {
            res.writeHead(proxyRes.statusCode, headers);
            return res.end(bodyBuffer);
        }

        const encoding = headers['content-encoding'];
        if (encoding === 'gzip') {
            // 解压 gzip 内容
            zlib.gunzip(bodyBuffer, (err, decodedBuffer) => {
                if (err) {
                    console.error('Gunzip error:', err);
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
            // 解压 deflate 内容
            zlib.inflate(bodyBuffer, (err, decodedBuffer) => {
                if (err) {
                    console.error('Inflate error:', err);
                    res.writeHead(proxyRes.statusCode, headers);
                    return res.end(bodyBuffer);
                }
                let bodyText = decodedBuffer.toString('utf8');
                bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
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
        } else {
            // 未压缩的内容
            let bodyText = bodyBuffer.toString('utf8');
            bodyText = bodyText.replace(new RegExp(targetUrl, 'g'), getNewBaseUrl(req));
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
    onProxyRes: modifyResponseBody
}));

// 如果不在 Vercel 环境中，则启动本地服务器
if (!process.env.VERCEL) {
    app.listen(3000, () => {
        console.log('Proxy server is running on http://localhost:3000');
    });
}

module.exports = app;
