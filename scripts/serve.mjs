import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.zip': 'application/zip', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
try { await fs.access(path.join(root, 'index.html')); } catch { console.error('未找到 dist/index.html，请先运行 npm run build。'); process.exit(1); }
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  try {
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (raw.includes('\\') || raw.includes('\0') || raw.split('/').includes('..')) { res.writeHead(403).end('Forbidden'); return; }
    let filename = path.resolve(root, '.' + raw);
    if (filename !== root && !filename.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
    if (raw.endsWith('/')) filename = path.join(filename, 'index.html');
    let stat; try { stat = await fs.stat(filename); } catch { if (path.extname(raw)) { res.writeHead(404).end('Not found'); return; } filename = path.join(root, 'index.html'); stat = await fs.stat(filename); }
    if (!stat.isFile() || !(await fs.realpath(filename)).startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(400).end('Bad request'); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口 4173 已被占用。请关闭已有学习工具窗口或占用该端口的程序，然后重试。' : `启动失败：${error.message}`); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => {
  console.log('日语学习工具：http://127.0.0.1:4173\n关闭此窗口即可停止服务。');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('explorer.exe', ['http://127.0.0.1:4173'], { stdio: 'ignore', detached: true, windowsHide: true });
    browser.on('error', () => console.log('请在浏览器中打开上述地址。')); browser.unref();
  }
});
