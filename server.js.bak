const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = 12 * 1024 * 1024;

function readAccessToken() {
  if (process.env.INATURALIST_ACCESS_TOKEN) return process.env.INATURALIST_ACCESS_TOKEN.trim();
  try {
    const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const line = envFile.split(/\r?\n/).find(entry => entry.trim().startsWith('INATURALIST_ACCESS_TOKEN='));
    if (!line) return '';
    return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch (_) {
    return '';
  }
}

function readUserJwt() {
  let value = readAccessToken();
  if (!value) return '';
  value = value.replace(/^Bearer\s+/i, '').trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') {
        value = parsed;
        continue;
      }
      if (parsed && typeof parsed.api_token === 'string') return parsed.api_token;
      break;
    } catch (_) {
      break;
    }
  }
  return value;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

async function readUpload(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) {
      request.resume();
      throw new Error('UPLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function identify(request, response) {
  const token = readUserJwt();
  if (!token) {
    return sendJson(response, 503, { error: 'iNaturalist API 토큰이 설정되지 않았어요.' });
  }
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return sendJson(response, 400, { error: '사진 파일을 찾지 못했어요. 이미지 파일을 다시 선택해 주세요.' });
  }

  try {
    const imageForm = await readUpload(request);
    const upstream = await fetch('https://api.inaturalist.org/v2/computervision/score_image?locale=ko', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': contentType,
        'User-Agent': 'SpeciesFieldGuide/1.0'
      },
      body: imageForm,
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok) {
      const message = upstream.status === 401 || upstream.status === 403
        ? 'iNaturalist 사용자 JWT 인증이 거부됐어요. 유효한 사용자 JWT가 필요해요.'
        : upstream.status === 429
          ? 'iNaturalist 요청이 많아요. 잠시 후 다시 시도해 주세요.'
          : 'iNaturalist 사진 판별을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.';
      return sendJson(response, 502, { error: message });
    }

    const result = await upstream.json();
    return sendJson(response, 200, result);
  } catch (error) {
    if (error.message === 'UPLOAD_TOO_LARGE') {
      return sendJson(response, 413, { error: '사진 용량은 10MB 이하로 선택해 주세요.' });
    }
    return sendJson(response, 502, { error: 'iNaturalist 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

function servePage(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    return response.end();
  }

  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
  const isGalleryImage = /^images\/gallery-(wildflowers|butterfly|forest)\.jpg$/.test(fileName);
  if (!['index.html', '__preview-bridge.js'].includes(fileName) && !isGalleryImage) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  const filePath = path.join(root, fileName);
  const type = fileName.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : fileName.endsWith('.jpg')
      ? 'image/jpeg'
      : 'text/javascript; charset=utf-8';
  response.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/identify') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      return response.end();
    }
    return identify(request, response);
  }
  return servePage(request, response, url.pathname);
});

server.listen(port, '0.0.0.0');
