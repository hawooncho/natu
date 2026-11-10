const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = 12 * 1024 * 1024;

function readEnvValue(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const line = envFile.split(/\r?\n/).find(entry => entry.trim().startsWith(`${name}=`));
    if (!line) return '';
    return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch (_) {
    return '';
  }
}

// iNaturalist's current API uses a JWT that expires after 24 hours.
// The JWT can be fetched automatically with the long-lived OAuth access token.
// Keep the OAuth credential on the server (Render environment variable), never in index.html.
let cachedJwt = '';
let cachedJwtExpiresAt = 0;
let jwtRefreshPromise = null;

function readOAuthAccessToken() {
  return readEnvValue('INATURALIST_OAUTH_ACCESS_TOKEN')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

async function getUserJwt(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedJwt && now < cachedJwtExpiresAt - 5 * 60 * 1000) {
    return cachedJwt;
  }

  if (jwtRefreshPromise) return jwtRefreshPromise;

  jwtRefreshPromise = (async () => {
    const oauthToken = readOAuthAccessToken();
    if (!oauthToken) throw new Error('INATURALIST_OAUTH_ACCESS_TOKEN_MISSING');

    const response = await fetch('https://www.inaturalist.org/users/api_token', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        Accept: 'application/json',
        'User-Agent': 'JitdaSpeciesGuide/1.0'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`INATURALIST_OAUTH_FAILED_${response.status}`);
    }

    const data = await response.json();
    const token = typeof data === 'string' ? data : data.api_token || data.access_token;
    if (!token) throw new Error('INATURALIST_JWT_MISSING');

    cachedJwt = String(token).replace(/^Bearer\s+/i, '').trim();
    // iNaturalist documents these JWTs as expiring after 24 hours.
    // Use a conservative 23-hour cache so the next request refreshes it early.
    cachedJwtExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
    return cachedJwt;
  })();

  try {
    return await jwtRefreshPromise;
  } finally {
    jwtRefreshPromise = null;
  }
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
  let token;
  try {
    token = await getUserJwt();
  } catch (error) {
    const message = error.message === 'INATURALIST_OAUTH_ACCESS_TOKEN_MISSING'
      ? 'Render 환경변수 INATURALIST_OAUTH_ACCESS_TOKEN이 설정되지 않았어요.'
      : 'iNaturalist 인증 토큰을 자동으로 갱신하지 못했어요. Render의 OAuth 토큰을 확인해 주세요.';
    return sendJson(response, 503, { error: message });
  }
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return sendJson(response, 400, { error: '사진 파일을 찾지 못했어요. 이미지 파일을 다시 선택해 주세요.' });
  }

  try {
    const imageForm = await readUpload(request);
    let upstream = await fetch('https://api.inaturalist.org/v2/computervision/score_image?locale=ko', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': contentType,
        'User-Agent': 'SpeciesFieldGuide/1.0'
      },
      body: imageForm,
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok && (upstream.status === 401 || upstream.status === 403)) {
      try {
        token = await getUserJwt(true);
        const retry = await fetch('https://api.inaturalist.org/v2/computervision/score_image?locale=ko', {
          method: 'POST',
          headers: {
            Authorization: token,
            'Content-Type': contentType,
            'User-Agent': 'JitdaSpeciesGuide/1.0'
          },
          body: imageForm,
          signal: AbortSignal.timeout(30000)
        });
        if (retry.ok) {
          const result = await retry.json();
          return sendJson(response, 200, result);
        }
        upstream = retry;
      } catch (_) {
        // Fall through to the normal error response below.
      }
    }

    if (!upstream.ok) {
      const message = upstream.status === 401 || upstream.status === 403
        ? 'iNaturalist 사용자 JWT 인증이 거부됐어요. Render의 OAuth 토큰을 확인해 주세요.'
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

async function inaturalistProxy(request, response, pathname, search) {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    return response.end();
  }
  const upstreamUrl = `https://api.inaturalist.org/v1${pathname.slice('/api/inaturalist'.length)}${search}`;
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JitdaSpeciesGuide/1.0'
      },
      signal: AbortSignal.timeout(15000)
    });
    const body = await upstream.arrayBuffer();
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(Buffer.from(body));
  } catch (_) {
    sendJson(response, 502, { error: 'iNaturalist API에 연결하지 못했어요.' });
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
  if (url.pathname.startsWith('/api/inaturalist/')) {
    return inaturalistProxy(request, response, url.pathname, url.search);
  }
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
