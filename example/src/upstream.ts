import * as http from 'node:http';

/** A stand-in upstream on :3901: echoes what the gateway forwards, so the headers it sets can be seen. */
const doc = {
  openapi: '3.0.0',
  info: { title: 'Acme Orders', version: '1' },
  paths: { '/orders': { get: { tags: ['orders'], responses: { 200: { description: 'orders' } } } } },
};
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
  if (req.url === '/api-json') return res.end(JSON.stringify(doc));
  res.end(JSON.stringify({ method: req.method, url: req.url, tenant: req.headers['x-acme-tenant-id'], principal: req.headers['x-acme-principal'] }));
}).listen(3901, () => console.log('stub upstream on :3901'));
