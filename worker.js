// MyStatus adapted from MyGB: https://github.com/verfasor/MyGB
// Thanks Sylvia for ideas and initial fork https://departure.blog/
// Worker.js v1.0.3c

// Session management
const SESSION_COOKIE_NAME = 'gb_session';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_FUTURE_SKEW_MS = 60 * 1000; // 1 minute clock skew allowance
const MARKED_BROWSER_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';

/** Page size for index first paint, Load more, and `/api/entries` (embed uses the same API). */
const ENTRIES_PAGE_LIMIT = 10;

/** Experimental R2 public media at `/media/<key>` (bind bucket as `MEDIA` in wrangler). */
const MEDIA_KEY_MAX = 120;
const MEDIA_LIST_LIMIT = 500;
const MEDIA_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

function getMediaBucket(env) {
  return env.MEDIA || null;
}

function isValidMediaObjectKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.length < 1 || key.length > MEDIA_KEY_MAX) return false;
  return /^[a-zA-Z0-9._-]+$/.test(key);
}

function inferExtensionFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'application/pdf': '.pdf'
  };
  return map[m] || '';
}

function mimeFromFilename(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return '';
}

function contentTypeFromMediaKey(key) {
  return mimeFromFilename(key) || 'application/octet-stream';
}

function isAllowedUploadMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpg') return true;
  if (m.startsWith('image/')) {
    return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m);
  }
  if (m === 'video/mp4' || m === 'video/webm') return true;
  if (m === 'audio/mpeg' || m === 'audio/mp3' || m === 'audio/wav' || m === 'audio/webm') return true;
  if (m === 'application/pdf') return true;
  return false;
}

function normalizeMediaObjectKeyFromFilename(filename) {
  const base = String(filename || '').replace(/^.*[/\\\\]/, '').trim();
  let key = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!key || key === '.' || key === '..') return '';
  if (key.length > MEDIA_KEY_MAX) {
    const dot = key.lastIndexOf('.');
    if (dot > 0 && key.length - dot <= 10) {
      const ext = key.slice(dot);
      const maxStem = MEDIA_KEY_MAX - ext.length;
      key = (maxStem > 0 ? key.slice(0, dot).slice(0, maxStem) : 'file') + ext;
    } else {
      key = key.slice(0, MEDIA_KEY_MAX);
    }
  }
  return isValidMediaObjectKey(key) ? key : '';
}

/** Root-relative R2 media paths allowed in markdown (same origin). */
function isSafeRelativeMediaUrl(url) {
  const m = String(url || '').trim().match(/^\/media\/([^/?#]+)$/);
  if (!m) return false;
  try {
    return isValidMediaObjectKey(decodeURIComponent(m[1]));
  } catch (e) {
    return false;
  }
}

// Login rate limiting
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_BLOCK_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map();

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// Access-Control-Allow-Origin
function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function getSessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (!secret || !String(secret).trim()) return null;
  return String(secret);
}

function base64UrlEncode(input) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return atob(normalized + padding);
}

function getClientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();

  return 'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };

  if (entry.blockedUntil && entry.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000)
    };
  }

  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || (now - entry.windowStart > LOGIN_WINDOW_MS)) {
    loginAttempts.set(ip, {
      count: 1,
      windowStart: now,
      blockedUntil: 0
    });
    return;
  }

  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
    entry.windowStart = now;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function isAllowedHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function validateAndNormalizeNavLinks(rawNavLinks) {
  if (!rawNavLinks) return { ok: true, value: '[]' };

  let parsed;
  try {
    parsed = JSON.parse(String(rawNavLinks));
  } catch (e) {
    return { ok: false, error: 'Invalid NAV_LINKS JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'NAV_LINKS must be an array' };
  }

  const normalized = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || '').trim();
    const linkUrl = String(item.url || '').trim();

    if (!linkUrl) continue;
    if (!isAllowedHttpUrl(linkUrl)) {
      return { ok: false, error: 'NAV_LINKS can only contain http(s) URLs' };
    }

    normalized.push({ label, url: linkUrl });
  }

  return { ok: true, value: JSON.stringify(normalized) };
}

function validateCsrfOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return { ok: false, error: 'CSRF Forbidden: Missing Origin' };
  }

  let originUrl;
  let requestUrl;
  try {
    originUrl = new URL(origin);
    requestUrl = new URL(request.url);
  } catch (e) {
    return { ok: false, error: 'CSRF Forbidden: Invalid Origin' };
  }

  // Allow protocol mismatch (http vs https) if host matches.
  if (originUrl.host !== requestUrl.host) {
    return {
      ok: false,
      error: `CSRF Forbidden: Origin '${origin}' does not match '${requestUrl.origin}'`
    };
  }

  return { ok: true };
}

function isMdScriptEnabled(value) {
  if (typeof value === 'boolean') return value;
  return String(value || '').trim().toLowerCase() === 'true';
}

function getMarkdownHelpText(value) {
  return isMdScriptEnabled(value)
    ? 'Markdown rendered with marked library (GFM + line breaks).'
    : 'Supports basic markdown formatting (built-in renderer).';
}

const SITE_INTRO_MAX_LEN = 2000;

function validateSiteIntro(raw) {
  const value = String(raw || '').replace(/\u0000/g, '');
  if (value.length > SITE_INTRO_MAX_LEN) {
    return { ok: false, error: `Site intro too long (max ${SITE_INTRO_MAX_LEN} chars)` };
  }
  return { ok: true, value };
}

const CLIENT_COMMON_JS = `
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDateString(dateStr) {
    if (!dateStr) return '';
    const isoDate = dateStr.replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z');
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function formatClientDates() {
    document.querySelectorAll('.client-date').forEach(el => {
      const dateStr = el.getAttribute('datetime');
      if (dateStr) el.textContent = formatDateString(dateStr);
      el.classList.remove('client-date');
    });
  }

  function sanitizeRenderedHtmlClient(html) {
    return String(html)
      .replace(/<\\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>/gi, '')
      .replace(/<\\s*(script|style|iframe|object|embed|link|meta)\\b[^>]*\\/?\\s*>/gi, '')
      .replace(/\\son[a-z]+\\s*=\\s*(".*?"|'.*?'|[^\\s>]+)/gi, '')
      .replace(/\\s(href|src)\\s*=\\s*"\\s*javascript:[^"]*"/gi, ' $1="#"')
      .replace(/\\s(href|src)\\s*=\\s*'\\s*javascript:[^']*'/gi, " $1='#'")
      .replace(/\\s(href|src)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"')
      .replace(/<a\\s/gi, '<a rel="nofollow noopener noreferrer" ');
  }

  function renderMarkdownContent(scope) {
    if (typeof marked === 'undefined' || typeof marked.parse !== 'function') return;
    const root = scope || document;
    root.querySelectorAll('.markdown-content').forEach(el => {
      if (el.dataset.mdRendered === '1') return;
      const markdown = el.textContent || '';
      const rendered = marked.parse(markdown, { gfm: true, breaks: true });
      el.innerHTML = sanitizeRenderedHtmlClient(rendered);
      el.dataset.mdRendered = '1';
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    formatClientDates();
    renderMarkdownContent(document);
  });

  window.renderMarkdownContent = renderMarkdownContent;
`;

async function sign(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key, encoder.encode(data)
  );
  // Use URL-safe base64 to avoid cookie issues
  return data + '.' + btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [data, signature] = token.split('.');
  // Re-sign the data to check if signature matches
  const expectedToken = await sign(data, secret);
  return expectedToken === token ? data : null;
}

async function createSessionToken(secret) {
  const now = Date.now();
  const payload = {
    sid: crypto.randomUUID(),
    iat: now,
    exp: now + SESSION_DURATION
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return await sign(encodedPayload, secret);
}

async function verifySession(request, env) {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;

  const cookies = Object.fromEntries(
    cookie.split(';').map(c => c.trim().split('='))
  );
  const sessionToken = cookies[SESSION_COOKIE_NAME];
  if (!sessionToken) return null;

  const secret = getSessionSecret(env);
  if (!secret) return null;

  const encodedPayload = await verify(sessionToken, secret);
  if (!encodedPayload) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (e) {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.sid !== 'string' || !payload.sid) return null;
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;

  const now = Date.now();
  if (payload.iat > now + SESSION_FUTURE_SKEW_MS) return null;
  if (payload.exp <= now) return null;

  return payload.sid;
}

async function checkPassword(input, expected) {
  if (!input || !expected) return false;
  const encoder = new TextEncoder();
  // Hash both to ensure constant time comparison of hashes
  const inputHash = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const expectedHash = await crypto.subtle.digest('SHA-256', encoder.encode(expected));

  const inputArr = new Uint8Array(inputHash);
  const expectedArr = new Uint8Array(expectedHash);

  if (inputArr.length !== expectedArr.length) return false;

  let result = 0;
  for (let i = 0; i < inputArr.length; i++) {
    result |= inputArr[i] ^ expectedArr[i];
  }
  return result === 0;
}

function setSessionCookie(sessionToken) {
  const expires = new Date(Date.now() + SESSION_DURATION).toUTCString();
  return `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// Status posts: supports markdown, auto-linked URLs, per-line <p> wrapping
function renderStatus(text) {
  if (!text) return '';

  function isValidUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // Process each line independently
  const lines = text.split('\n');
  const rendered = lines.map(line => {
    // Build an array of {type, value} tokens
    const tokens = [{ type: 'raw', value: line }];

    function processTokens(fn) {
      const next = [];
      for (const token of tokens) {
        if (token.type !== 'raw') { next.push(token); continue; }
        fn(token.value, next);
      }
      tokens.length = 0;
      tokens.push(...next);
    }

    // Markdown images: ![alt](url)
    processTokens((str, out) => {
      const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        const alt = m[1];
        const url = m[2];
        if (isValidUrl(url) || isSafeRelativeMediaUrl(url)) {
          out.push({ type: 'html', value: `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">` });
        } else {
          out.push({ type: 'raw', value: m[0] });
        }
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Markdown links with nested formatting: [text](url) — http(s) or /media/... for R2
    processTokens((str, out) => {
      const re = /\[([^\]]+)\]\((https?:\/\/[^\s]+|\/media\/[a-zA-Z0-9._-]+)\)/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });

        const linkText = m[1];
        const url = m[2];

        // Process nested formatting (like italics or bold) within the link text
        const processedLinkText = linkText
          .replace(/\*\*(.*?)\*\*/g, (_, m) => `<strong>${escapeHtml(m)}</strong>`)  // Bold
          .replace(/\*(.*?)\*/g, (_, m) => `<em>${escapeHtml(m)}</em>`);            // Italic

        if (isValidUrl(url) || isSafeRelativeMediaUrl(url)) {
          out.push({
            type: 'html',
            value: `<a href="${escapeHtml(url)}" rel="nofollow noopener noreferrer">${processedLinkText}</a>`
          });
        } else {
          out.push({ type: 'raw', value: m[0] });
        }

        last = re.lastIndex;
      }

      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Markdown bold: **bold**
    processTokens((str, out) => {
      const re = /\*\*(.*?)\*\*/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        out.push({ type: 'html', value: `<strong>${escapeHtml(m[1])}</strong>` });
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Markdown italic: *italic*
    processTokens((str, out) => {
      const re = /\*(.*?)\*/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        out.push({ type: 'html', value: `<em>${escapeHtml(m[1])}</em>` });
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Markdown inline code: `code`
    processTokens((str, out) => {
      const re = /`(.*?)`/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        out.push({ type: 'html', value: `<code>${escapeHtml(m[1])}</code>` });
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Markdown strikethrough: ~~strikethrough~~
    processTokens((str, out) => {
      const re = /~~(.*?)~~/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        out.push({ type: 'html', value: `<del>${escapeHtml(m[1])}</del>` });
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Auto-link bare URLs
    processTokens((str, out) => {
      const re = /https?:\/\/[^\s<>"']+/g;
      let last = 0, m;
      while ((m = re.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'raw', value: str.slice(last, m.index) });
        const url = m[0];
        if (isValidUrl(url)) {
          out.push({ type: 'html', value: `<a href="${escapeHtml(url)}" rel="nofollow noopener noreferrer">${escapeHtml(url)}</a>` });
        } else {
          out.push({ type: 'raw', value: url });
        }
        last = re.lastIndex;
      }
      if (last < str.length) out.push({ type: 'raw', value: str.slice(last) });
    });

    // Escape remaining raw tokens and assemble the line
    const assembled = tokens.map(t => t.type === 'raw' ? escapeHtml(t.value) : t.value).join('');

    // Wrap lines in <p>
    if (assembled.trim() === '') return '';
    return `<p>${assembled}</p>`;
  });

  return rendered.filter(l => l !== '').join('\n');
}

const COMMON_CSS = `
    :root {
      --primary: #af04a7;
      --primary-hover: #8d0386;
      --bg: #fff5fe;
      --card-bg: #fff9fe;
      --text: #50014c;
      --text-muted: #ad71aa;
      --text-content: #50014c;
      --border: #f4e0f3;
      --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --active-nav-bg: #fde5fc;
      --active-nav-color: var(--primary);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --primary: #5f0059;
        --primary-hover: #6e0167;
        --bg: #32012f;
        --card-bg: #3d0039;
        --text: #ffd3fc;
        --text-muted: #94a3b8;
        --text-content: #ffd3fc;
        --border: #5b1256;
        --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.5), 0 2px 4px -2px rgb(0 0 0 / 0.5);
        --active-nav-bg: #6a0464;
        --active-nav-color: #e0f2fe;
      }

      input, textarea {
        background-color: var(--card-bg) !important;
        color: var(--text) !important;
        border-color: var(--border) !important;
      }

      .entries-table th {
        color: var(--text-muted) !important;
        border-bottom-color: var(--border) !important;
      }

      pre {
        background-color: #020617 !important;
        color: #e2e8f0 !important;
        border-color: var(--border) !important;
      }
      
      /* Dark mode overrides for mobile menu */ 
      @media (max-width: 768px) {
        .nav-links {
          background-color: var(--card-bg) !important;
          border-color: var(--border) !important;
        }
        .nav-links a:hover {
          background-color: var(--border) !important;
        }
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5;
      color: var(--text);
      background: var(--bg);
      padding: 2rem 1rem;
    }
    .container {
      max-width: var(--container-width, 1000px);
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    h1 {
       font-size: 1.25rem;
       font-weight: 700;
       color: var(--text);
     }
    .nav-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      transition: all 0.2s;
      margin-left: 0.5rem;
    }
    .nav-links a:hover {
      background: var(--border);
      color: var(--text);
    }
    .nav-links a.active {
      background: var(--active-nav-bg);
      color: var(--active-nav-color);
    }
    .card {
      background: var(--card-bg);
      border-radius: 0.75rem;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      overflow: hidden;
      margin-bottom: 2rem;
    }
    .form-group {
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: var(--text);
      font-size: 0.9375rem;
    }
    input[type="text"],
    input[type="email"],
    input[type="url"],
    input[type="password"],
    textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 1rem;
      transition: border-color 0.15s;
      background: #fff;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }
    button {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-weight: 600;
      transition: background-color 0.15s;
    }
    button:hover {
      background: var(--primary-hover);
    }
    button:disabled {
      background: var(--text-muted);
      cursor: not-allowed;
      opacity: 0.7;
    }
    .message {
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1.5rem;
      font-size: 0.9375rem;
    }
    .message.success {
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #a7f3d0;
    }
    .message.error {
      background: #fef2f2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
    .text-muted { color: var(--text-muted); }
    .text-sm { font-size: 0.75rem; }

    .logout {
      color: #ef4444 !important;
    }
    .logout:hover {
      background: #fef2f2 !important;
    }
    /* Mobile Menu */
    .hamburger { display: none; background: none; border: none; font-size: 1.5rem; padding: 0.5rem; color: var(--text); cursor: pointer; }
    @media (max-width: 768px) {
      .hamburger { display: block; width: initial; }
      .nav-links {
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: var(--card-bg);
        border-bottom: 1px solid var(--border);
        flex-direction: column;
        padding: 1rem;
        box-shadow: var(--shadow);
        z-index: 50;
      }
      .nav-links.active { display: flex; }
      .nav-links a { margin: 0 0 0.5rem 0; display: block; text-align: center; padding: 0.75rem; }
      header { position: relative; }
    }
`;

const PUBLIC_SITE_SHARED_STYLES = `
    .container { max-width: 700px; }
    h1 { font-size: 1.5rem; letter-spacing: -0.025em; }
    .header-nav { display: flex; gap: 1rem; align-items: center; }
    .nav-link { color: var(--text-muted); text-decoration: none; font-size: 0.9375rem; font-weight: 500; transition: color 0.2s; }
    .nav-link:hover { color: var(--primary); }
    .entry {
      background: var(--card-bg);
      border-radius: 0.75rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }
    .entry-content { color: var(--text-content); line-height: 1.625; font-size: 0.9375rem; }
    .entry-content pre {
      padding: 10px;
      margin-bottom: 10px;
      border-radius: 10px;
    }
    .entry-content ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    .entry-content p { margin-bottom: 1rem; }
    a { color: inherit; text-decoration: underline; }
    img { max-width: 100%; }
`;

function getHead(title, siteIcon, extraStyles = '', extraHead = '', noIndex = false) {
  let metaTags = '';
  if (noIndex) {
    metaTags += '<meta name="robots" content="noindex, nofollow">\n';
  }
  return `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${metaTags}
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="${escapeHtml(siteIcon)}">
  <link rel="apple-touch-icon" href="${escapeHtml(siteIcon)}">
  <style>
    ${COMMON_CSS}
    ${extraStyles}
  </style>
  ${extraHead}
</head>`;
}

function getAdminHeader(activePage) {
  return `
    <header>
      <h1>Admin Panel</h1>
      <button class="hamburger" onclick="document.querySelector('.nav-links').classList.toggle('active')" aria-label="Toggle menu">☰</button>
      <div class="nav-links">
        <a href="/admin" class="${activePage === 'post' ? 'active' : ''}">Post</a>
        <a href="/admin/entries" class="${activePage === 'entries' ? 'active' : ''}">Entries</a>
        <a href="/admin/embed" class="${activePage === 'embed' ? 'active' : ''}">Embed</a>
        <a href="/admin/media" class="${activePage === 'media' ? 'active' : ''}">Media</a>
        <a href="/admin/settings" class="${activePage === 'settings' ? 'active' : ''}">Settings</a>
        <a href="/" target="_blank">View Site</a>
        <a href="#" onclick="logout(); return false;" class="logout">Logout</a>
      </div>
    </header>`;
}

function getPublicFooterHTML() {
  return `
    <footer style="text-align: center; margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.875rem;">
      <p><a href="/feed.xml">Atom Feed</a> · <a href="/sitemap.xml">Sitemap</a></p>
      <p>Based on <a href="https://mighil.com/mygb" target="_blank" rel="noopener noreferrer">MyGB</a> · Thanks <a href="https://departure.blog/" target="_blank" rel="noopener noreferrer">Sylvia</a> for the first draft</p>
      <p><a href="https://github.com/verfasor/mystatus" target="_blank" rel="noopener noreferrer">Source</a> available under GNU AGPL v3</p>
    </footer>`;
}

// Configuration Helpers
async function initializeDatabase(env) {
  try {
    const batch = [
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_created_at ON entries(created_at)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`)
    ];
    await env.DB.batch(batch);
    console.log('Database initialized');
  } catch (e) {
    console.error('Failed to initialize database', e);
  }
}

async function getAppConfig(env) {
  const config = {
    SITENAME: env.SITENAME || 'Status',
    SITE_INTRO: env.SITE_INTRO || '',
    SITE_DESCRIPTION: env.SITE_DESCRIPTION || 'A personal status stream.',
    SITE_ICON_URL: env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp',
    SITE_COVER_IMAGE_URL: env.SITE_COVER_IMAGE_URL || '',
    NAV_LINKS: env.NAV_LINKS || '[]',
    CANONICAL_URL: env.CANONICAL_URL || '',
    ALLOW_INDEXING: env.ALLOW_INDEXING !== 'false',
    CUSTOM_CSS: env.CUSTOM_CSS || '',
    MD_SCRIPT: isMdScriptEnabled(env.MD_SCRIPT),
    // These remain cloudflare-main-env-only
    ADMIN_PASSWORD: env.ADMIN_PASSWORD,
    SESSION_SECRET: env.SESSION_SECRET,
    DB: env.DB,
    API_URL: env.API_URL
  };

  try {
    // Try to fetch settings from DB 
    const settings = await env.DB.prepare('SELECT key, value FROM settings').all();
    if (settings.results) {
      settings.results.forEach(row => {
        if (row.key === 'ALLOW_INDEXING') {
          config[row.key] = row.value === 'true';
        } else {
          config[row.key] = row.value;
        }
      });
    }
  } catch (e) {
    // Table might not exist yet, try to initialize 
    await initializeDatabase(env);
  }

  return config;
}

async function saveAppSettings(env, settings) {
  // Ensure table exists (lazy init) 
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  } catch (e) {
    console.error('Failed to create settings table', e);
  }

  const stmt = env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const batch = [];

  for (const [key, value] of Object.entries(settings)) {
    batch.push(stmt.bind(key, String(value)));
  }

  await env.DB.batch(batch);
}

function getSettingsHTML(config) {
  const sitename = config.SITENAME || 'Status';
  const siteIcon = config.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';

  const extraStyles = `
    .help-text { font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem; }
    .checkbox-group { display: flex; align-items: center; gap: 0.75rem; }
    .checkbox-group input { width: 1rem; height: 1rem; margin: 0; cursor: pointer; }
    .checkbox-group label { margin-bottom: 0; cursor: pointer; font-weight: 400; }
    .btn-export {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text);
      background: var(--card-bg);
      font-size: 0.875rem;
      font-weight: 500;
      transition: background 0.15s;
    }
    .btn-export:hover {
      background: var(--border);
    }
    .card-header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .card-header h3 {
      margin: 0;
      font-size: 1.125rem;
      font-weight: 600;
    }
    .card-body {
      padding: 1.5rem;
    }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Settings - ' + sitename, siteIcon, extraStyles + (config.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('settings')}

    <div id="message-container"></div>

    <form id="settings-form">
      <!-- General Settings -->
      <div class="card">
        <div class="card-header">
          <h3>General</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label for="SITENAME">Site Name</label>
            <input type="text" id="SITENAME" name="SITENAME" value="${escapeHtml(config.SITENAME)}">
            <div class="help-text">Used as the page title.</div>
          </div>
          <div class="form-group">
            <label for="SITE_INTRO">Site Intro</label>
            <textarea id="SITE_INTRO" name="SITE_INTRO" rows="3" style="width: 100%; box-sizing: border-box;">${escapeHtml(config.SITE_INTRO || '')}</textarea>
            <div class="help-text">Displayed on the home page above the stream. Markdown (same as statuses): ${escapeHtml(getMarkdownHelpText(config.MD_SCRIPT))}</div>
          </div>
          <div class="form-group">
            <label for="SITE_DESCRIPTION">Site Description</label>
            <textarea id="SITE_DESCRIPTION" name="SITE_DESCRIPTION" rows="2" style="width: 100%; box-sizing: border-box;">${escapeHtml(config.SITE_DESCRIPTION || '')}</textarea>
            <div class="help-text">Used for meta description and social media cards.</div>
          </div>
          <div class="form-group">
            <label for="SITE_ICON_URL">Site Icon URL</label>
            <input type="url" id="SITE_ICON_URL" name="SITE_ICON_URL" value="${escapeHtml(config.SITE_ICON_URL)}">
            <div class="help-text">URL to your site's favicon or logo (square recommended).</div>
          </div>
          <div class="form-group">
            <label for="SITE_COVER_IMAGE_URL">Site Cover Image URL</label>
            <input type="url" id="SITE_COVER_IMAGE_URL" name="SITE_COVER_IMAGE_URL" value="${escapeHtml(config.SITE_COVER_IMAGE_URL || '')}">
            <div class="help-text">URL to an image used for social media sharing (Open Graph / Twitter). Recommended size: 1200x630.</div>
          </div>
          <div class="form-group">
            <label for="CANONICAL_URL">Canonical URL</label>
            <input type="url" id="CANONICAL_URL" name="CANONICAL_URL" value="${escapeHtml(config.CANONICAL_URL || '')}">
            <div class="help-text">The authoritative URL for your status stream. Useful if you embed the stream on another site.</div>
          </div>
          <div class="checkbox-group" style="margin-top: 1rem;">
            <input type="checkbox" id="ALLOW_INDEXING" name="ALLOW_INDEXING" ${config.ALLOW_INDEXING ? 'checked' : ''}>
            <label for="ALLOW_INDEXING">Allow Search Engine Indexing</label>
          </div>
          <div class="help-text">If unchecked, adds <code>noindex, nofollow</code> to prevent search engines from indexing this page.</div>
        </div>
      </div>

      <!-- Navigation Settings --> 
      <div class="card">
        <div class="card-header">
          <h3>Navigation</h3>
        </div>
        <div class="card-body">
          <p class="text-muted" style="margin-bottom: 1rem; font-size: 0.875rem;">Add links to your main website or other pages. These will appear in the header.</p>
          <div id="nav-links-container"></div>
          <button type="button" id="add-link-btn" style="margin-top: 1rem; background: var(--card-bg); color: var(--text); border: 1px dashed var(--border); width: auto;">+ Add Link</button>
          <input type="hidden" id="NAV_LINKS" name="NAV_LINKS" value="${escapeHtml(config.NAV_LINKS || '[]')}">
        </div>
      </div>
      
      <!-- Appearance Settings --> 
      <div class="card">
        <div class="card-header">
          <h3>Appearance</h3>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label for="CUSTOM_CSS">Custom CSS</label>
            <textarea id="CUSTOM_CSS" name="CUSTOM_CSS" placeholder=".container { max-width: 800px; }" style="font-family: monospace; min-height: 150px; width: 100%; box-sizing: border-box;">${escapeHtml(config.CUSTOM_CSS || '')}</textarea>
            <div class="help-text">Add custom CSS to style the stream and admin UI.</div>
          </div>
        </div>
      </div>
      
      <!-- Export Data --> 
      <div class="card">
        <div class="card-header">
          <h3>Export Data</h3>
        </div>
        <div class="card-body">
          <p class="text-muted" style="margin-bottom: 1rem; font-size: 0.875rem;">Download your status stream data.</p>
          <div style="display: flex; gap: 1rem;">
            <a href="/data.json" target="_blank" class="btn-export">Download JSON</a>
            <a href="/data.csv" target="_blank" class="btn-export">Download CSV</a>
          </div>
        </div>
      </div>

      <div style="position: sticky; bottom: 1rem; z-index: 10;">
        <button type="submit" style="width: 100%; padding: 0.75rem 1.5rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);">Save Settings</button>
      </div>
    </form>
  </div>

  <script>
    // Navigation Links Management
    const navLinksInput = document.getElementById('NAV_LINKS');
    const navLinksContainer = document.getElementById('nav-links-container');
    const addLinkBtn = document.getElementById('add-link-btn');

    let navLinks = [];
    try {
      navLinks = JSON.parse(navLinksInput.value || '[]');
      
     } catch (e) {
       navLinks = [];
     }

    function renderNavLinks() {
      navLinksContainer.innerHTML = '';
      if (navLinks.length === 0) {
        navLinksContainer.innerHTML = '<p class="text-muted" style="font-style: italic; font-size: 0.875rem;">No links added yet.</p>';
      }
      navLinks.forEach((link, index) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;';
        // Simple escape for attribute values
        const safeLabel = (link.label || '').replace(/"/g, '&quot;');
        const safeUrl = (link.url || '').replace(/"/g, '&quot;');
        
        row.innerHTML =
          '<input type="text" placeholder="Label" value="' + safeLabel + '" data-index="' + index + '" data-key="label" class="nav-link-input" style="flex: 1;">' +
          '<input type="url" placeholder="URL" value="' + safeUrl + '" data-index="' + index + '" data-key="url" class="nav-link-input" style="flex: 2;">' +
          '<button type="button" data-index="' + index + '" class="remove-link-btn" style="padding: 0.5rem 0.75rem; background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; border-radius: 0.375rem; cursor: pointer; width: auto; font-weight: bold;">&times;</button>';
        navLinksContainer.appendChild(row);
      });
    }

    function updateHiddenInput() {
      navLinksInput.value = JSON.stringify(navLinks);
    }
    
    // Event delegation for inputs
    navLinksContainer.addEventListener('input', (e) => {
      if (e.target.classList.contains('nav-link-input')) {
        const index = parseInt(e.target.dataset.index);
        const key = e.target.dataset.key;
        navLinks[index][key] = e.target.value;
        updateHiddenInput();
      }
    });

    // Event delegation for remove buttons
    navLinksContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-link-btn')) {
        const index = parseInt(e.target.dataset.index);
        navLinks.splice(index, 1);
        renderNavLinks();
        updateHiddenInput();
      }
    });

    addLinkBtn.addEventListener('click', () => {
      navLinks.push({ label: '', url: '' });
      renderNavLinks();
      updateHiddenInput();
    });

    renderNavLinks();

    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const button = form.querySelector('button[type="submit"]');
      const messageContainer = document.getElementById('message-container');
      const formData = new FormData(form);

      button.disabled = true;
      button.textContent = 'Saving...';

      try {
        const response = await fetch('/api/settings', {
        
          method: 'POST',
          body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
          messageContainer.innerHTML = '<div class="message success">Settings saved successfully. Reloading...</div>';
          setTimeout(() => location.reload(), 1000);
        } else {
          messageContainer.innerHTML = '<div class="message error">' + (result.error || 'Failed to save settings') + '</div>';
        }
      } catch (error) {
        messageContainer.innerHTML = '<div class="message error">An error occurred. Please try again.</div>';
      } finally {
        button.disabled = false;
        button.textContent = 'Save Settings';
      }
    });

    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        window.location.href = '/login';
      }
    }
  </script>
</body>
</html>`;
}

// HTML templates
function getIndexHTML(entries, env, currentHostname) {
  const sitename = env.SITENAME || 'Status';
  const useMdScript = isMdScriptEnabled(env.MD_SCRIPT);
  const siteIntroRaw = env.SITE_INTRO || '';
  const siteIntroHTML =
    String(siteIntroRaw).trim() === ''
      ? ''
      : `<div class="site-intro${useMdScript ? ' markdown-content' : ''}" style="margin-bottom: 1.5rem; color: var(--text); line-height: 1.6;">${
          useMdScript ? escapeHtml(siteIntroRaw) : renderStatus(siteIntroRaw)
        }</div>`;

  const entriesHTML = entries.length === 0
    ? `<div class="empty-state"><p>No statuses yet.</p></div>`
    : entries.map(entry => `
      <article class="entry">
        <div class="entry-content${useMdScript ? ' markdown-content' : ''}">${useMdScript ? escapeHtml(entry.status) : renderStatus(entry.status)}</div>
        <div class="entry-meta">
          <span class="entry-date client-date" datetime="${escapeHtml(entry.created_at)}">${formatDate(entry.created_at)}</span>
        </div>
        <a class="entry-link" href="/${entry.id}" aria-label="Open status ${entry.id}"></a>
      </article>
    `).join('');
    
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  
  // Meta tags
  const siteDescription = env.SITE_DESCRIPTION || 'A personal status stream.';
  const siteCoverImage = env.SITE_COVER_IMAGE_URL || '';
  const canonicalUrl = env.CANONICAL_URL || '';
  const allowIndexing = env.ALLOW_INDEXING !== false;

  let extraHead = `${useMdScript ? `<script src="${escapeHtml(MARKED_BROWSER_SCRIPT_URL)}"></script>` : ''}
  <script>${CLIENT_COMMON_JS}</script>`;

   if (!allowIndexing) {
     extraHead += `
   <meta name="robots" content="noindex, nofollow">`;
   }

   if (canonicalUrl) {
     extraHead += `
   <link rel="canonical" href="${escapeHtml(canonicalUrl)}">`;
   }

   if (siteDescription) {
     extraHead += `
   <meta name="description" content="${escapeHtml(siteDescription)}">`;
   }

  extraHead += `
  <link rel="alternate" type="application/atom+xml" title="${escapeHtml(sitename)}" href="/feed.xml">`;

  extraHead += `
  <meta property="og:title" content="${escapeHtml(sitename)}">`;

  if (siteDescription) {
    extraHead += `
  <meta property="og:description" content="${escapeHtml(siteDescription)}">`;
  }

  if (siteCoverImage) {
    extraHead += `
  <meta property="og:image" content="${escapeHtml(siteCoverImage)}">`;
  }

  extraHead += `
  <meta name="twitter:title" content="${escapeHtml(sitename)}">`;

  if (siteDescription) {
    extraHead += `
  <meta name="twitter:description" content="${escapeHtml(siteDescription)}">`;
  }

  if (siteCoverImage) {
    extraHead += `
  <meta name="twitter:image" content="${escapeHtml(siteCoverImage)}">
  <meta name="twitter:card" content="summary_large_image">`;
  } else {
    extraHead += `
  <meta name="twitter:card" content="summary">`;
  }

  let navLinks = [];
  try {
    navLinks = JSON.parse(env.NAV_LINKS || '[]');
  } catch (e) {
    navLinks = [];
  }

  const navLinksHTML = navLinks.length > 0 ? `
    <nav class="header-nav">
      ${navLinks.map(link => `<a href="${escapeHtml(link.url)}" class="nav-link">${escapeHtml(link.label)}</a>`).join('')}
    </nav>` : '';

  const extraStyles = `
    ${PUBLIC_SITE_SHARED_STYLES}
    .card { padding: 2rem; }
    button { width: 100%; }
    textarea { min-height: 120px; resize: vertical; }
    h2 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .entry {
      margin-bottom: 1rem;
      transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
      position: relative;
    }
    .entry:hover {
      border-color: var(--primary);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.08);
    }
    /* Full-card target without wrapping content that may contain <a> (invalid nested anchors). */
    .entry-link {
      position: absolute;
      inset: 0;
      z-index: 1;
      border-radius: inherit;
      text-decoration: none;
    }
    .entry-content {
      position: relative;
      z-index: 2;
      pointer-events: none;
    }
    .entry-content a,
    .entry-content button,
    .entry-content input,
    .entry-content select,
    .entry-content textarea {
      position: relative;
      z-index: 2;
      pointer-events: auto;
    }
    .entry-meta {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      z-index: 2;
      pointer-events: none;
    }
    .entry-date { color: var(--text-muted); font-size: 0.75rem;}
    .entry-link:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
    .empty-state { text-align: center; padding: 4rem 2rem; color: var(--text-muted); }
    .site-intro { font-size: 0.9375rem; }
    .site-intro p { margin-bottom: 0.75rem; }
    .site-intro p:last-child { margin-bottom: 0; }
    @media (max-width: 640px) {
      .entry-content { padding-left: 0; margin-top: 1rem; }
    }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead(sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), extraHead)}
<body>
  <div class="container">
    <header>
      <h1 class="site-name">${escapeHtml(sitename)}</h1>
      ${navLinksHTML}
    </header>

    ${siteIntroHTML}

    <div class="entries-section">
      <div id="entries-container">
        ${entriesHTML}
      </div>
      <div id="load-more-container" style="text-align: center; margin-top: 2rem; display: ${entries.length >= ENTRIES_PAGE_LIMIT ? 'block' : 'none'};">
        <button id="load-more-btn" style="background: var(--card-bg); color: var(--text); border: 1px solid var(--border); padding: 0.5rem 1rem; border-radius: 0.5rem; cursor: pointer; font-size: 0.875rem;" data-cursor="${entries.length > 0 ? entries[entries.length - 1].id : ''}">Load More</button>
      </div>
    </div>
    ${getPublicFooterHTML()}
  </div>

  <script>
    // Load More functionality
    const loadMoreBtn = document.getElementById('load-more-btn');
    const entriesContainer = document.getElementById('entries-container');

    const useMdScript = ${useMdScript ? 'true' : 'false'};

    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', async () => {
        const cursor = loadMoreBtn.getAttribute('data-cursor');
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';

        try {
          const response = await fetch('/api/entries?cursor=' + cursor);
          const data = await response.json();

          if (data.success && data.entries.length > 0) {
            data.entries.forEach(entry => {
              const article = document.createElement('article');
              article.className = 'entry';
              const dt = escapeHtml(String(entry.created_at || ''));
              article.innerHTML =
                '<div class="entry-content' + (useMdScript ? ' markdown-content' : '') + '"></div>' +
                '<div class="entry-meta">' +
                  '<span class="entry-date client-date" datetime="' + dt + '">' + formatDateString(entry.created_at) + '</span>' +
                '</div>';
              const overlay = document.createElement('a');
              overlay.className = 'entry-link';
              overlay.href = '/' + entry.id;
              overlay.setAttribute('aria-label', 'Open status ' + entry.id);
              article.appendChild(overlay);
              const contentEl = article.querySelector('.entry-content');
              if (useMdScript) {
                contentEl.textContent = entry.status || '';
              } else {
                contentEl.innerHTML = entry.rendered || '';
              }
              if (useMdScript && typeof window.renderMarkdownContent === 'function') {
                window.renderMarkdownContent(article);
              }
              entriesContainer.appendChild(article);
            });

            if (data.nextCursor) {
              loadMoreBtn.setAttribute('data-cursor', data.nextCursor);
              loadMoreBtn.disabled = false;
              loadMoreBtn.textContent = 'Load More';
            } else {
              document.getElementById('load-more-container').style.display = 'none';
            }
          } else {
            document.getElementById('load-more-container').style.display = 'none';
          }
        } catch (error) {
          console.error('Error loading more entries:', error);
          loadMoreBtn.disabled = false;
          loadMoreBtn.textContent = 'Load More';
        }
      });
    }

    ${CLIENT_COMMON_JS}
  </script>
</body>
</html>`;
}

function getSingleStatusHTML(entry, env) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  const pageTitle = `Status #${entry.id} - ${sitename}`;
  const useMdScript = isMdScriptEnabled(env.MD_SCRIPT);

  const statusDescription = entry.status
    ? entry.status.replace(/\n/g, ' ').slice(0, 160)
    : 'Status update';

  const extraHead = `
  <meta name="description" content="${escapeHtml(statusDescription)}">
  <link rel="canonical" href="${escapeHtml((env.CANONICAL_URL || '').replace(/\/$/, '') + '/' + entry.id)}">
  ${useMdScript ? `<script src="${escapeHtml(MARKED_BROWSER_SCRIPT_URL)}"></script>` : ''}
  <script>${CLIENT_COMMON_JS}</script>`;

  let navLinks = [];
  try {
    navLinks = JSON.parse(env.NAV_LINKS || '[]');
  } catch (e) {
    navLinks = [];
  }

  const navLinksHTML = navLinks.length > 0 ? `
    <nav class="header-nav">
      ${navLinks.map(link => `<a href="${escapeHtml(link.url)}" class="nav-link">${escapeHtml(link.label)}</a>`).join('')}
    </nav>` : '';

  const extraStyles = `
    ${PUBLIC_SITE_SHARED_STYLES}
    header { margin-bottom: 1.25rem; }
    .back-link {
      display: inline-block;
      margin-bottom: 1rem;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
    }
    .back-link:hover { color: var(--primary); text-decoration: underline; }
    .entry-date { color: var(--text-muted); font-size: 0.75rem; display: inline-block; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead(pageTitle, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), extraHead)}
<body>
  <div class="container">
    <header>
      <h1 class="site-name">${escapeHtml(sitename)}</h1>
      ${navLinksHTML}
    </header>

    <a class="back-link" href="/">← Back to all statuses</a>

    <article class="entry">
      <div class="entry-content${useMdScript ? ' markdown-content' : ''}">${useMdScript ? escapeHtml(entry.status) : renderStatus(entry.status)}</div>
      <div class="entry-meta">
        <span class="entry-date client-date" datetime="${entry.created_at}">${formatDate(entry.created_at)}</span>
      </div>
    </article>

    ${getPublicFooterHTML()}
  </div>
</body>
</html>`;
}

function getLoginHTML(env) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';

  const extraStyles = `
    body { display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
    .login-container {
      background: var(--card-bg);
      padding: 2.5rem;
      border-radius: 1rem;
      box-shadow: var(--shadow);
      width: 100%;
      max-width: 400px;
      border: 1px solid var(--border);
    }
    .brand { text-align: center; margin-bottom: 2rem; }
    .brand-icon { font-size: 3rem; margin-bottom: 0.5rem; display: inline-block; }
    h1 { margin-bottom: 0.5rem; font-size: 1.5rem; }
    .subtitle { color: var(--text-muted); font-size: 0.875rem; }
    button { width: 100%; padding: 0.75rem; }
    .message { text-align: center; padding: 0.75rem; }
    .back-link {
      display: block;
      text-align: center;
      margin-top: 1.5rem;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.875rem;
      transition: color 0.2s;
    }
    .back-link:hover { color: var(--primary); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Login - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="login-container">
    <div class="brand">
      <img src="${escapeHtml(siteIcon)}" alt="Logo" width="64" height="64" style="margin-bottom: 1rem; border-radius: 8px;">
      <h1>Admin Login</h1>
      <p class="subtitle">Enter your password to post statuses</p>
    </div>

    <div id="message-container"></div>

    <form id="login-form">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus>
      </div>
      <button type="submit">Sign In</button>
    </form>
    <a href="/" class="back-link">Back to Stream</a>
  </div>

  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const button = form.querySelector('button[type="submit"]');
      const messageContainer = document.getElementById('message-container');
      const formData = new FormData(form);

      button.disabled = true;
      button.textContent = 'Logging in...';

      try {
        const response = await fetch('/login', {
          method: 'POST',
          body: formData
        });

        const result = await response.json();

        if (result.success) {
          window.location.href = '/admin';
        } else {
          messageContainer.innerHTML = '<div class="message error">Invalid password</div>';
          form.reset();
        }
      } catch (error) {
        messageContainer.innerHTML = '<div class="message error">An error occurred. Please try again.</div>';
      } finally {
        button.disabled = false;
        button.textContent = 'Login';
      }
    });
  </script>
</body>
</html>`;
}

function getEmbedHTML(env, origin) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  const useMdScript = isMdScriptEnabled(env.MD_SCRIPT);

  const embedCode = `<!-- Status Stream Widget Container -->
<div
  data-gb
  data-gb-api-url="${origin}"
></div>

${useMdScript ? `<!-- Optional: Markdown renderer (enabled because MD_SCRIPT=true) -->
<script src="${MARKED_BROWSER_SCRIPT_URL}"></script>

` : ''}<!-- Load the status stream client script -->
<script src="${origin}/client.js"></script>`;

  const extraStyles = `
    pre {
      background: #50014c;
      padding: 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
      border: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.875rem;
      margin-bottom: 1rem !important;
      color: #f0f0f0;
      padding: 10px;
      border-radius: 10px !important; 
    }
    .copy-btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .copy-btn:hover { background: var(--primary-hover); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Embed - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('embed')}

    <div class="card">
      <div style="padding: 1.5rem; border-bottom: 1px solid var(--border);">
        <h2 style="font-size: 1.125rem; font-weight: 600; margin: 0;">Embed Code</h2>
      </div>
      <div style="padding: 1.5rem;">
        <p style="margin-bottom: 1rem; color: var(--text-muted);">Copy the code below and paste it into your website where you want the status stream to appear.</p>
        <div style="position: relative;">
          <pre><code id="embed-code">${escapeHtml(embedCode)}</code></pre>
          <button class="copy-btn" onclick="copyCode()">Copy Code</button>
          <span id="copy-success" style="margin-left: 0.5rem; color: var(--success); opacity: 0; transition: opacity 0.2s;">Copied!</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    function copyCode() {
      const code = document.getElementById('embed-code').innerText;
      navigator.clipboard.writeText(code).then(() => {
        const successMsg = document.getElementById('copy-success');
        successMsg.style.opacity = '1';
        setTimeout(() => {
          successMsg.style.opacity = '0';
        }, 2000);
      });
    }

    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        alert('Failed to logout');
      }
    }
  </script>
</body>
</html>`;
}

function getAdminMediaHTML(env, objects, mediaConfigured, publicBase) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  const base = String(publicBase || '').replace(/\/$/, '');

  const rowsHTML = !mediaConfigured
    ? ''
    : objects.length === 0
      ? '<div class="empty-state">No files in the bucket yet. Upload something below.</div>'
      : `
      <div class="table-responsive">
        <table class="entries-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>URL</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${objects.map(o => {
    const key = escapeHtml(o.key);
    const relPath = '/media/' + encodeURIComponent(o.key);
    const absUrl = base ? escapeHtml(base + relPath) : escapeHtml(relPath);
    const sz = o.size != null ? escapeHtml(formatByteSize(o.size)) : '';
    const up = o.uploaded != null ? escapeHtml(formatUploadedDate(o.uploaded)) : '';
    return `
              <tr>
                <td><code>${key}</code></td>
                <td class="text-muted text-sm">${sz}</td>
                <td class="text-muted text-sm">${up}</td>
                <td><a href="${relPath}" target="_blank" rel="noopener noreferrer">Open</a></td>
                <td class="entry-actions">
                  <button type="button" class="btn-edit media-copy" data-url="${absUrl}">Copy URL</button>
                  <button type="button" class="btn-delete media-delete" data-key="${key}">Delete</button>
                </td>
              </tr>`;
  }).join('')}
          </tbody>
        </table>
      </div>`;

  const setupHTML = !mediaConfigured
    ? `<div class="message" style="margin-bottom:1rem;padding:1rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--card-bg);">
        <strong>Experimental:</strong> bind an R2 bucket to this Worker as <code>MEDIA</code> (see <code>wrangler.toml.example</code> in the repo), redeploy, then reload this page.
      </div>`
    : `<p class="help-text" style="margin-bottom:1rem;">Public URL pattern: <code>/media/&lt;filename&gt;</code>. Use in statuses, e.g. <code>![](/media/photo.png)</code> or <code>[label](/media/doc.pdf)</code>. Same-origin URLs work with the built-in renderer; absolute URLs need <code>https://</code>.</p>
      <form id="media-upload-form" enctype="multipart/form-data" style="margin-bottom:1.5rem;padding:1rem;border:1px solid var(--border);border-radius:0.5rem;">
        <label for="media-file" style="display:block;margin-bottom:0.5rem;font-weight:600;">Upload file</label>
        <input type="file" id="media-file" name="file" required accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/webm,application/pdf,.mp3,.pdf">
        <button type="submit" id="media-upload-btn" style="margin-top:0.75rem;width:auto;">Upload</button>
      </form>`;

  const extraStyles = `
    .table-responsive { overflow-x: auto; }
    .entries-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .entries-table th {
      text-align: left;
      padding: 1rem;
      background: var(--card-bg);
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--border);
    }
    .entries-table td { padding: 1rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    .entries-table tr:last-child td { border-bottom: none; }
    .entry-actions { white-space: nowrap; }
    .btn-edit { display: inline-block; text-decoration: none; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 0.25rem 0.75rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; margin-right: 0.5rem; border: 1px solid #bfdbfe; }
    .btn-edit:hover { background: #dbeafe; }
    .btn-delete { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; padding: 0.25rem 0.75rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
    .btn-delete:hover { background: #fee2e2; }
    .empty-state { padding: 2rem; text-align: center; color: var(--text-muted); font-style: italic; }
    .help-text { font-size: 0.875rem; color: var(--text-muted); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Media - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('media')}
    <div id="message-container"></div>
    <div class="card">
      <div style="padding: 1.5rem; border-bottom: 1px solid var(--border);">
        <h2 style="font-size: 1.125rem; font-weight: 600; margin: 0;">Media (R2)</h2>
      </div>
      <div style="padding: 1.5rem;">
        ${setupHTML}
        ${rowsHTML}
      </div>
    </div>
  </div>
  <script>
    document.querySelectorAll('.media-copy').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var u = this.getAttribute('data-url');
        if (u) navigator.clipboard.writeText(u).then(function() {
          var c = document.getElementById('message-container');
          if (c) c.innerHTML = '<div class="message success">Copied URL</div>';
          setTimeout(function() { if (c) c.innerHTML = ''; }, 2000);
        });
      });
    });
    document.querySelectorAll('.media-delete').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var key = this.getAttribute('data-key');
        if (!key || !confirm('Delete ' + key + '?')) return;
        try {
          var fd = new FormData();
          fd.set('key', key);
          var res = await fetch('/api/media/delete', { method: 'POST', body: fd });
          var j = await res.json();
          if (j.success) location.reload();
          else alert(j.error || 'Delete failed');
        } catch (e) {
          alert('Delete failed');
        }
      });
    });
    var mform = document.getElementById('media-upload-form');
    if (mform) {
      mform.addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = document.getElementById('media-upload-btn');
        var mc = document.getElementById('message-container');
        var fd = new FormData(mform);
        btn.disabled = true;
        btn.textContent = 'Uploading...';
        try {
          var res = await fetch('/api/media/upload', { method: 'POST', body: fd });
          var j = await res.json();
          if (j.success) {
            if (mc) mc.innerHTML = '<div class="message success">Uploaded: ' + (j.url || '') + '</div>';
            mform.reset();
            setTimeout(function() { location.reload(); }, 800);
          } else {
            if (mc) mc.innerHTML = '<div class="message error">' + (j.error || 'Upload failed') + '</div>';
          }
        } catch (err) {
          if (mc) mc.innerHTML = '<div class="message error">Upload failed</div>';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Upload';
        }
      });
    }
    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        window.location.href = '/login';
      }
    }
  </script>
</body>
</html>`;
}

// Post a new status page
function getAdminPostHTML(env) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  const markdownHelpText = getMarkdownHelpText(env.MD_SCRIPT);

  const extraStyles = `
    textarea { min-height: 160px; }
    button { width: 100%; }
    .help-text { font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Post - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('post')}
    <div id="message-container"></div>
    <div class="card">
      <div style="padding: 1.5rem; border-bottom: 1px solid var(--border);">
        <h2 style="font-size: 1.125rem; font-weight: 600; margin: 0;">New Status</h2>
      </div>
      <div style="padding: 1.5rem;">
        <form id="post-form">
          <div class="form-group">
            <textarea id="status" name="status" required placeholder="What's on your mind?"></textarea>
            <div class="help-text">${escapeHtml(markdownHelpText)}</div>
          </div>
          <button type="submit" id="submit-btn">Post</button>
        </form>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('post-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const button = document.getElementById('submit-btn');
      const messageContainer = document.getElementById('message-container');
      const formData = new FormData(form);

      button.disabled = true;
      button.textContent = 'Posting...';

      try {
        const response = await fetch('/api/submit', { method: 'POST', body: formData });
        const result = await response.json();
        if (result.success) {
          messageContainer.innerHTML = '<div class="message success">Status posted!</div>';
          form.reset();
          setTimeout(() => { messageContainer.innerHTML = ''; }, 3000);
        } else {
          messageContainer.innerHTML = '<div class="message error">' + (result.error || 'Failed to post status.') + '</div>';
        }
      } catch (error) {
        messageContainer.innerHTML = '<div class="message error">An error occurred. Please try again.</div>';
      } finally {
        button.disabled = false;
        button.textContent = 'Post';
      }
    });

    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        window.location.href = '/login';
      }
    }
  </script>
</body>
</html>`;
}

function getAdminEntriesHTML(entries, env) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';

  const entriesHTML = entries.length === 0
    ? '<div class="empty-state">No entries yet.</div>'
    : `
      <div class="table-responsive">
        <table class="entries-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(entry => `
              <tr>
                <td class="text-muted text-sm">
                  ${entry.id}
                </td>
                <td>
                  <div class="message-content">${escapeHtml(entry.status.slice(0, 60)).replace(/\n/g, '<br>')}</div>
                </td>
                <td class="text-muted text-sm client-date" datetime="${entry.created_at}">
                  ${formatDate(entry.created_at)}
                </td>
                <td class="entry-actions">
                  <a href="/admin/entries/edit?entry=${entry.id}" class="btn-edit" title="Edit">Edit</a>
                  <button onclick="deleteEntry(${entry.id})" class="btn-delete" title="Delete">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

  const extraStyles = `
    .table-responsive { overflow-x: auto; }
    .entries-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .entries-table th {
      text-align: left;
      padding: 1rem;
      background:var(--card-bg);
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--border);
    }
    .entries-table td {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    .entries-table tr:last-child td { border-bottom: none; }
    .message-content { max-width: 400px; color: var(--text-content); }
    .entry-actions { white-space: nowrap; }
    .btn-edit { display: inline-block; text-decoration: none; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 0.25rem 0.75rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; margin-right: 0.5rem; }
    .btn-edit:hover { background: #dbeafe; }
    .btn-delete { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; padding: 0.25rem 0.75rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
    .btn-delete:hover { background: #fee2e2; }
    .empty-state { padding: 4rem 2rem; text-align: center; color: var(--text-muted); font-style: italic; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Entries - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('entries')}

    <div id="message-container"></div>

    <div class="card">
      <div style="padding: 1.5rem; border-bottom: 1px solid var(--border);">
        <h2 style="font-size: 1.125rem; font-weight: 600; margin: 0;">All Entries</h2>
      </div>
      ${entriesHTML}
    </div>
  </div>

  <script>
    async function deleteEntry(id) {
      if (!confirm('Are you sure you want to delete this entry?')) return;

      try {
        const response = await fetch('/api/delete/' + id, { method: 'POST' });
        const result = await response.json();
        if (result.success) {
          location.reload();
        } else {
          alert('Failed to delete entry: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        alert('An error occurred: ' + error.message);
      }
    }

    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        window.location.href = '/login';
      }
    }

    ${CLIENT_COMMON_JS}
  </script>
</body>
</html>`;
}

function getAdminEditEntryHTML(entry, env) {
  const sitename = env.SITENAME || 'Status';
  const siteIcon = env.SITE_ICON_URL || 'https://static.mighil.com/images/2026/mystatus.webp';
  const markdownHelpText = getMarkdownHelpText(env.MD_SCRIPT);

  const extraStyles = `
    textarea { min-height: 180px; }
    button { width: 100%; }
    .help-text { font-size: 0.875rem; color: var(--text-muted); margin-top: 0.25rem; }
    .actions-row { display: flex; gap: 0.75rem; margin-top: 1rem; }
    .btn-secondary { flex: 1; display: inline-flex; justify-content: center; align-items: center; text-decoration: none; border: 1px solid var(--border); border-radius: 0.5rem; color: var(--text); background: var(--card-bg); padding: 0.75rem 1.5rem; font-weight: 600; }
    .btn-secondary:hover { background: var(--border); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
${getHead('Edit Entry - ' + sitename, siteIcon, extraStyles + (env.CUSTOM_CSS || ''), '', true)}
<body>
  <div class="container">
    ${getAdminHeader('entries')}
    <div id="message-container"></div>
    <div class="card">
      <div style="padding: 1.5rem; border-bottom: 1px solid var(--border);">
        <h2 style="font-size: 1.125rem; font-weight: 600; margin: 0;">Edit Entry #${entry.id}</h2>
      </div>
      <div style="padding: 1.5rem;">
        <form id="edit-form">
          <div class="form-group">
            <label for="status">Status</label>
            <textarea id="status" name="status" required>${escapeHtml(entry.status || '')}</textarea>
            <div class="help-text">${escapeHtml(markdownHelpText)}</div>
          </div>
          <div class="actions-row">
            <button type="submit" id="save-btn">Save Changes</button>
            <a href="/admin/entries" class="btn-secondary">Cancel</a>
          </div>
        </form>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const button = document.getElementById('save-btn');
      const messageContainer = document.getElementById('message-container');
      const formData = new FormData(form);

      button.disabled = true;
      button.textContent = 'Saving...';

      try {
        const response = await fetch('/api/update/${entry.id}', { method: 'POST', body: formData });
        const result = await response.json();
        if (result.success) {
          messageContainer.innerHTML = '<div class="message success">Entry updated successfully. Redirecting...</div>';
          setTimeout(() => {
            window.location.href = '/admin/entries';
          }, 800);
        } else {
          messageContainer.innerHTML = '<div class="message error">' + (result.error || 'Failed to update entry.') + '</div>';
        }
      } catch (error) {
        messageContainer.innerHTML = '<div class="message error">An error occurred. Please try again.</div>';
      } finally {
        button.disabled = false;
        button.textContent = 'Save Changes';
      }
    });

    async function logout() {
      try {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (error) {
        window.location.href = '/login';
      }
    }
  </script>
</body>
</html>`;
}

function getClientScript(env, requestUrl) {
  // Use API_URL from env, or derive from request URL
  const apiUrl = env.API_URL || (requestUrl ? new URL(requestUrl).origin : '');
  const useMdScript = isMdScriptEnabled(env.MD_SCRIPT);

  return `(function() {
  const GB_API_URL = ${JSON.stringify(String(apiUrl))};
  const USE_MD_SCRIPT = ${useMdScript ? 'true' : 'false'};

  function sanitizeRenderedHtml(html) {
    return String(html)
      .replace(/<\\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>/gi, '')
      .replace(/<\\s*(script|style|iframe|object|embed|link|meta)\\b[^>]*\\/?\\s*>/gi, '')
      .replace(/\\son[a-z]+\\s*=\\s*(".*?"|'.*?'|[^\\s>]+)/gi, '')
      .replace(/\\s(href|src)\\s*=\\s*"\\s*javascript:[^"]*"/gi, ' $1="#"')
      .replace(/\\s(href|src)\\s*=\\s*'\\s*javascript:[^']*'/gi, " $1='#'")
      .replace(/\\s(href|src)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"')
      .replace(/<a\\s/gi, '<a rel="nofollow noopener noreferrer" ');
  }

  // Guestbook widget
  function GuestbookWidget(config) {
    this.container = typeof config.container === 'string'
      ? document.querySelector(config.container)
      : config.container;
    this.apiUrl = config.apiUrl || GB_API_URL;
    this.init();
  }

  GuestbookWidget.prototype.init = function() {
    if (!this.container) {
      console.error('Status Stream: Container not found');
      return;
    }
    
    this.render();
    this.loadEntries();
  };

  GuestbookWidget.prototype.render = function() {
    this.nextCursor = null;
    this.container.innerHTML =
      '<div class="gb-widget">' +
        '<div class="gb-entries">' +
          '<div class="gb-entries-list"></div>' +
          '<div class="gb-load-more-wrap" style="text-align:center;margin-top:1rem;display:none;">' +
            '<button type="button" class="gb-load-more-btn">Load more</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    var self = this;
    var btn = this.container.querySelector('.gb-load-more-btn');
    if (btn) {
      btn.addEventListener('click', function() { self.loadMoreEntries(); });
    }
  };

  GuestbookWidget.prototype.fetchEntriesPage = function(cursor) {
    var q = cursor != null && cursor !== '' ? ('?cursor=' + encodeURIComponent(String(cursor))) : '';
    return fetch(this.apiUrl + '/api/entries' + q).then(function(r) { return r.json(); });
  };

  GuestbookWidget.prototype.appendEntryArticles = function(entries) {
    var list = this.container.querySelector('.gb-entries-list');
    if (!list || !entries || !entries.length) return;
    var self = this;
    var html = entries.map(function(entry) {
      return '<article class="gb-entry">' +
        '<div class="gb-entry-content">' + self.renderEntryContent(entry) + '</div>' +
        '<div class="gb-entry-meta"><span class="gb-entry-date">' + self.formatDate(entry.created_at) + '</span></div>' +
      '</article>';
    }).join('');
    list.insertAdjacentHTML('beforeend', html);
  };

  GuestbookWidget.prototype.setLoadMoreVisible = function(visible) {
    var wrap = this.container.querySelector('.gb-load-more-wrap');
    if (wrap) wrap.style.display = visible ? 'block' : 'none';
  };

  GuestbookWidget.prototype.loadEntries = async function() {
    var entriesList = this.container.querySelector('.gb-entries-list');
    if (!entriesList) return;

    entriesList.innerHTML = '<div class="gb-loading">Loading...</div>';
    this.setLoadMoreVisible(false);
    this.nextCursor = null;

    try {
      var result = await this.fetchEntriesPage(null);
      if (result.success && result.entries) {
        entriesList.innerHTML = '';
        if (result.entries.length === 0) {
          entriesList.innerHTML = '<div class="gb-no-entries">No statuses yet.</div>';
        } else {
          this.appendEntryArticles(result.entries);
          this.nextCursor = result.nextCursor != null ? result.nextCursor : null;
          this.setLoadMoreVisible(!!this.nextCursor);
        }
      } else {
        entriesList.innerHTML = '<div class="gb-error">Failed to load statuses.</div>';
      }
    } catch (error) {
      entriesList.innerHTML = '<div class="gb-error">Failed to load statuses.</div>';
    }
  };

  GuestbookWidget.prototype.loadMoreEntries = async function() {
    if (!this.nextCursor) return;
    var loadBtn = this.container.querySelector('.gb-load-more-btn');
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading...';
    }
    try {
      var result = await this.fetchEntriesPage(this.nextCursor);
      if (result && result.success && result.entries && result.entries.length > 0) {
        this.appendEntryArticles(result.entries);
      }
      if (result && result.success) {
        this.nextCursor = result.nextCursor != null ? result.nextCursor : null;
        this.setLoadMoreVisible(!!this.nextCursor);
      }
    } catch (e) {
      // keep button for retry
    }
    if (loadBtn) {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load more';
    }
  };

  GuestbookWidget.prototype.formatDate = function(dateString) {
    if (!dateString) return '';
    const isoDate = dateString.replace(' ', 'T') + (dateString.includes('Z') ? '' : 'Z');
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  GuestbookWidget.prototype.renderEntryContent = function(entry) {
    if (
      USE_MD_SCRIPT &&
      typeof marked !== 'undefined' &&
      typeof marked.parse === 'function'
    ) {
      const markdown = (entry && entry.status) || '';
      return sanitizeRenderedHtml(marked.parse(markdown, { gfm: true, breaks: true }));
    }
    return (entry && entry.rendered) || '';
  };
  
  // CSS Styles
  const style = document.createElement('style');
  style.textContent = \`
    .gb-widget { font-family: inherit; color: inherit; }
    .gb-load-more-btn {
      cursor: pointer;
      font: inherit;
      padding: 0.4rem 0.9rem;
      border-radius: 0.375rem;
      border: 1px solid rgba(0,0,0,0.15);
      background: rgba(0,0,0,0.04);
      color: inherit;
    }
    .gb-load-more-btn:disabled { cursor: not-allowed; opacity: 0.7; }
  \`;
  document.head.appendChild(style);

  // Export
  window.GuestbookWidget = GuestbookWidget;

  // Auto-initialize if data-gb attribute is present
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-gb]').forEach(container => {
      new GuestbookWidget({
        container: container,
        apiUrl: container.getAttribute('data-gb-api-url') || GB_API_URL
      });
    });
  });
})();`;
}

// Utility functions
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(dateString) {
  if (!dateString) return '';
  // Fix for SQLite date format
  const isoDate = dateString.replace(' ', 'T') + (dateString.includes('Z') ? '' : 'Z');
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return dateString;

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/** R2 object `uploaded` (Date, ms, or ISO string) -> same display as status dates. */
function formatUploadedDate(uploaded) {
  if (uploaded == null || uploaded === '') return '';
  let d;
  if (uploaded instanceof Date) {
    d = uploaded;
  } else if (typeof uploaded === 'number') {
    d = new Date(uploaded);
  } else {
    d = new Date(String(uploaded));
  }
  if (isNaN(d.getTime())) return '';
  return formatDate(d.toISOString());
}

/** Bytes -> short human string (B, KB, MB, GB). */
function formatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const k = 1024;
  if (n < k) return Math.round(n) + ' B';
  if (n < k * k) {
    const v = n / k;
    const t = Math.round(v * 10) / 10;
    return (t % 1 === 0 ? String(Math.round(t)) : t.toFixed(1)) + ' KB';
  }
  if (n < k * k * k) {
    const v = n / (k * k);
    const t = Math.round(v * 10) / 10;
    return (t % 1 === 0 ? String(Math.round(t)) : t.toFixed(1)) + ' MB';
  }
  const v = n / (k * k * k);
  const t = Math.round(v * 10) / 10;
  return (t % 1 === 0 ? String(Math.round(t)) : t.toFixed(1)) + ' GB';
}

/** Atom `<title>`: plain text from first line, or `Status #id` when the post leads with a markdown image. */
function getAtomEntryTitle(entry) {
  const firstLine = String(entry.status || '').split('\n')[0].trim();
  if (!firstLine) {
    return escapeHtml(`Status #${entry.id}`);
  }
  if (/^\s*!\[[^\]]*\]\(/.test(firstLine) || /^\s*<img\b/i.test(firstLine)) {
    return escapeHtml(`Status #${entry.id}`);
  }
  const plainText = firstLine
    // Markdown images -> keep alt text only.
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    // Markdown links -> keep link text only.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    // Inline code -> keep code text only.
    .replace(/`([^`]+)`/g, '$1')
    // Strip HTML tags if present.
    .replace(/<[^>]*>/g, '')
    // Remove common markdown markers.
    .replace(/(\*\*|__|\*|_|~~|#+|>)/g, '')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim();
  if (!plainText) {
    return escapeHtml(`Status #${entry.id}`);
  }
  const display = plainText.length > 60 ? plainText.slice(0, 60) + '\u2026' : plainText;
  return escapeHtml(display);
}

// RSS feed
function getFeedXML(entries, config) {
  const siteUrl = config.CANONICAL_URL || config.API_URL || '';
  const feedBaseUrl = String(siteUrl).replace(/\/$/, '');
  const sitename = config.SITENAME || 'Status';

  // Use the most recent entry date as the feed's updated timestamp, or now if empty
  const updated = entries.length > 0
    ? entries[0].created_at.replace(' ', 'T') + (entries[0].created_at.includes('Z') ? '' : 'Z')
    : new Date().toISOString();

  // Extract hostname once for use in all entry tag URIs
  const hostname = new URL(siteUrl).hostname;

  const entryItems = entries.map(entry => {
    // Normalise SQLite date to ISO 8601 UTC
    const entryDate = entry.created_at.replace(' ', 'T') + (entry.created_at.includes('Z') ? '' : 'Z');

    // Build tag URI date and time components from the entry's creation timestamp
    // Format: tag:hostname,YYYY-MM-DD:HH-MM-SS
    const iso = new Date(entryDate).toISOString();
    const tagDate = iso.slice(0, 10);                    // e.g. 2026-04-07
    const tagTime = iso.slice(11, 19).replace(/:/g, '-'); // e.g. 17-53-48
    const entryId = `tag:${hostname},${tagDate}:${tagTime}`;

    const entryLink = feedBaseUrl ? `${feedBaseUrl}/${entry.id}` : `/${entry.id}`;

    // Render markdown status to HTML, then entity-escape for XML inclusion
    const renderedContent = renderStatus(entry.status);
    const escapedContent = renderedContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const entryTitle = getAtomEntryTitle(entry);

    return `  <entry>
    <title>${entryTitle}</title>
    <link href="${escapeHtml(entryLink)}"/>
    <id>${escapeHtml(entryId)}</id>
    <updated>${entryDate}</updated>
    <content type="html">${escapedContent}</content>
  </entry>`;
  }).join('\n');

  const homeLink = feedBaseUrl ? `${feedBaseUrl}/` : '/';
  const selfLink = feedBaseUrl ? `${feedBaseUrl}/feed.xml` : '/feed.xml';
  const feedId = feedBaseUrl ? `${feedBaseUrl}/` : '/';

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(sitename)}</title>
  <link href="${escapeHtml(homeLink)}"/>
  <link rel="self" href="${escapeHtml(selfLink)}"/>
  <updated>${updated}</updated>
  <id>${escapeHtml(feedId)}</id>
${entryItems}
</feed>`;
}

function getSitemapXML(entries, config, requestOrigin) {
  const baseUrl = String(config.CANONICAL_URL || config.API_URL || requestOrigin || '').replace(/\/$/, '');

  const homeLastmod = entries.length > 0
    ? entries[0].created_at.replace(' ', 'T') + (entries[0].created_at.includes('Z') ? '' : 'Z')
    : new Date().toISOString();

  const homeUrlEntry = `  <url>
    <loc>${escapeHtml(baseUrl + '/')}</loc>
    <lastmod>${escapeHtml(homeLastmod)}</lastmod>
  </url>`;

  const statusUrls = entries.map(entry => {
    const lastmod = entry.created_at
      ? entry.created_at.replace(' ', 'T') + (entry.created_at.includes('Z') ? '' : 'Z')
      : new Date().toISOString();

    return `  <url>
    <loc>${escapeHtml(baseUrl + '/' + entry.id)}</loc>
    <lastmod>${escapeHtml(lastmod)}</lastmod>
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${homeUrlEntry}
${statusUrls}
</urlset>`;
}

// Main handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const config = await getAppConfig(env);

    try {
      if (request.method === 'OPTIONS') {
        const allowedOrigin = getAllowedOrigin(request, env);
        return new Response(null, {
          headers: {
            ...CORS_HEADERS,
            ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {})
          }
        });
      }

      // Favicon
      if (path === '/favicon.ico') {
        return Response.redirect(config.SITE_ICON_URL, 301);
      }

      // Atom feed
      if (path === '/feed.xml') {
        const entries = await env.DB.prepare(
          'SELECT id, status, created_at FROM entries ORDER BY id DESC LIMIT 10'
        ).all();
        return new Response(getFeedXML(entries.results || [], config), {
          headers: {
            'Content-Type': 'application/atom+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300'
          }
        });
      }

      // Sitemap
      if (path === '/sitemap.xml') {
        const entries = await env.DB.prepare(
          'SELECT id, created_at FROM entries ORDER BY id DESC'
        ).all();
        return new Response(getSitemapXML(entries.results || [], config, url.origin), {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300'
          }
        });
      }

      // Public R2 media: GET|HEAD /media/<key>
      const mediaPathMatch = path.match(/^\/media\/([^/]+)$/);
      if (mediaPathMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        let rawKey;
        try {
          rawKey = decodeURIComponent(mediaPathMatch[1]);
        } catch (e) {
          return new Response('Bad Request', { status: 400 });
        }
        if (!isValidMediaObjectKey(rawKey)) {
          return new Response('Bad Request', { status: 400 });
        }
        const mediaBucket = getMediaBucket(env);
        if (!mediaBucket) {
          return new Response('Media not configured', { status: 503 });
        }
        const obj = await mediaBucket.get(rawKey);
        if (!obj) {
          return new Response('Not Found', { status: 404 });
        }
        const ct = obj.httpMetadata?.contentType || contentTypeFromMediaKey(rawKey);
        const mediaHeaders = new Headers();
        mediaHeaders.set('Content-Type', ct);
        mediaHeaders.set('Cache-Control', 'public, max-age=3600');
        if (request.method === 'HEAD') {
          return new Response(null, { status: 200, headers: mediaHeaders });
        }
        return new Response(obj.body, { status: 200, headers: mediaHeaders });
      }

      // Public API: entries (read-only, serves pre-rendered HTML for load-more)
      if (path === '/api/entries') {
        const limit = ENTRIES_PAGE_LIMIT;
        const cursor = url.searchParams.get('cursor');

        let query = 'SELECT id, status, created_at FROM entries';
        const params = [];

        if (cursor) {
          query += ' WHERE id < ?';
          params.push(parseInt(cursor));
        }

        query += ' ORDER BY id DESC LIMIT ?';
        params.push(limit);

        const entries = await env.DB.prepare(query).bind(...params).all();
        const results = (entries.results || []).map(entry => ({
          ...entry,
          rendered: renderStatus(entry.status)
        }));
        const nextCursor = results.length === limit ? results[results.length - 1].id : null;

        const allowedOrigin = getAllowedOrigin(request, env);
        return new Response(JSON.stringify({ success: true, entries: results, nextCursor }), {
          headers: Object.assign(
            { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=60' },
            allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}
          )
        });
      }

      // Protected API: submit (admin only)
      if (path === '/api/submit') {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const username = await verifySession(request, env);
        if (!username) {
          return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const csrfCheck = validateCsrfOrigin(request);
        if (!csrfCheck.ok) {
          return new Response(JSON.stringify({ success: false, error: csrfCheck.error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const formData = await request.formData();
        const status = formData.get('status')?.trim();

        if (!status) {
          return new Response(JSON.stringify({ success: false, error: 'Status text is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Input length validation
        if (status.length > 2000) {
          return new Response(JSON.stringify({ success: false, error: 'Status too long (max 2000 chars)' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Insert into database
        const result = await env.DB.prepare(
          'INSERT INTO entries (status, created_at) VALUES (?, datetime("now"))'
        ).bind(status).run();

        return new Response(JSON.stringify({ success: true, id: result.meta.last_row_id }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Admin API routes (protected)
      if (path.startsWith('/api/')) {
        const username = await verifySession(request, env);
        if (!username) {
          return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // CSRF Check (require Origin on state-changing admin API calls)
        const csrfCheck = validateCsrfOrigin(request);
        if (!csrfCheck.ok) {
          return new Response(JSON.stringify({ success: false, error: csrfCheck.error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path === '/api/settings' && request.method === 'POST') {
          const formData = await request.formData();
          const navLinksValidation = validateAndNormalizeNavLinks(formData.get('NAV_LINKS'));
          if (!navLinksValidation.ok) {
            return new Response(JSON.stringify({ success: false, error: navLinksValidation.error }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const siteIntroValidation = validateSiteIntro(formData.get('SITE_INTRO'));
          if (!siteIntroValidation.ok) {
            return new Response(JSON.stringify({ success: false, error: siteIntroValidation.error }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const settings = {
            SITENAME: formData.get('SITENAME') || 'Status',
            SITE_INTRO: siteIntroValidation.value,
            SITE_DESCRIPTION: formData.get('SITE_DESCRIPTION') || '',
            SITE_ICON_URL: formData.get('SITE_ICON_URL') || '',
            SITE_COVER_IMAGE_URL: formData.get('SITE_COVER_IMAGE_URL') || '',
            NAV_LINKS: navLinksValidation.value,
            CANONICAL_URL: formData.get('CANONICAL_URL') || '',
            ALLOW_INDEXING: formData.get('ALLOW_INDEXING') === 'on',
            CUSTOM_CSS: formData.get('CUSTOM_CSS') || ''
          };
          
          await saveAppSettings(env, settings);
          
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path.startsWith('/api/delete/')) {
          const id = parseInt(path.split('/').pop());
          await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path.startsWith('/api/update/') && request.method === 'POST') {
          const id = parseInt(path.split('/').pop(), 10);
          if (!Number.isInteger(id) || id <= 0) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid entry ID' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const formData = await request.formData();
          const status = formData.get('status')?.trim();

          if (!status) {
            return new Response(JSON.stringify({ success: false, error: 'Status text is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          if (status.length > 2000) {
            return new Response(JSON.stringify({ success: false, error: 'Status too long (max 2000 chars)' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          await env.DB.prepare('UPDATE entries SET status = ? WHERE id = ?').bind(status, id).run();
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path === '/api/media/upload' && request.method === 'POST') {
          const mediaBucket = getMediaBucket(env);
          if (!mediaBucket) {
            return new Response(JSON.stringify({ success: false, error: 'R2 bucket MEDIA is not bound' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const uploadForm = await request.formData();
          const uploadFile = uploadForm.get('file');
          if (!uploadFile || typeof uploadFile.arrayBuffer !== 'function') {
            return new Response(JSON.stringify({ success: false, error: 'Missing file' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const uploadSize = uploadFile.size != null ? uploadFile.size : 0;
          if (uploadSize > MEDIA_UPLOAD_MAX_BYTES) {
            return new Response(JSON.stringify({ success: false, error: 'File too large (max 15 MB)' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          let uploadMime = String(uploadFile.type || '').toLowerCase();
          if (!uploadMime) uploadMime = mimeFromFilename(uploadFile.name || '');
          if (!uploadMime) uploadMime = 'application/octet-stream';
          if (!isAllowedUploadMime(uploadMime)) {
            return new Response(JSON.stringify({ success: false, error: 'File type not allowed' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          let objectKey = normalizeMediaObjectKeyFromFilename(uploadFile.name || '');
          if (!objectKey) {
            const ext = inferExtensionFromMime(uploadMime) || '';
            objectKey = 'upload-' + crypto.randomUUID().replace(/-/g, '').slice(0, 16) + ext;
          }
          if (!isValidMediaObjectKey(objectKey)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid filename' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const uploadBody = await uploadFile.arrayBuffer();
          await mediaBucket.put(objectKey, uploadBody, { httpMetadata: { contentType: uploadMime } });
          const mediaPublicPath = '/media/' + encodeURIComponent(objectKey);
          return new Response(JSON.stringify({ success: true, url: mediaPublicPath, key: objectKey }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path === '/api/media/delete' && request.method === 'POST') {
          const delBucket = getMediaBucket(env);
          if (!delBucket) {
            return new Response(JSON.stringify({ success: false, error: 'R2 bucket MEDIA is not bound' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const delForm = await request.formData();
          const rawDelKey = delForm.get('key');
          const delKey = typeof rawDelKey === 'string' ? rawDelKey.trim() : '';
          if (!isValidMediaObjectKey(delKey)) {
            return new Response(JSON.stringify({ success: false, error: 'Invalid key' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          await delBucket.delete(delKey);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // Login routes
      if (path === '/login') {
        if (request.method === 'POST') {
          const clientIp = getClientIp(request);
          const rateLimit = checkLoginRateLimit(clientIp);
          if (!rateLimit.allowed) {
            return new Response(JSON.stringify({ success: false, error: 'Too many login attempts. Try again later.' }), {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': String(rateLimit.retryAfterSeconds || 60)
              }
            });
          }

          const formData = await request.formData();
          const password = formData.get('password');

          if (!password || !config.ADMIN_PASSWORD) {
            recordLoginFailure(clientIp);
            return new Response(JSON.stringify({ success: false }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          const sessionSecret = getSessionSecret(env);
          if (!sessionSecret) {
            return new Response(JSON.stringify({ success: false, error: 'Server misconfigured: SESSION_SECRET is required' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          if (await checkPassword(password, config.ADMIN_PASSWORD)) {
            const sessionToken = await createSessionToken(sessionSecret);
            clearLoginFailures(clientIp);
            return new Response(JSON.stringify({ success: true }), {
              headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': setSessionCookie(sessionToken)
              }
            });
          }

          recordLoginFailure(clientIp);
          return new Response(JSON.stringify({ success: false }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        // If already logged in, redirect to admin
        const username = await verifySession(request, env);
        if (username) {
          return Response.redirect(url.origin + '/admin', 302);
        }

        return new Response(getLoginHTML(config), {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      if (path === '/logout') {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const csrfCheck = validateCsrfOrigin(request);
        if (!csrfCheck.ok) {
          return new Response(JSON.stringify({ success: false, error: csrfCheck.error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearSessionCookie()
          }
        });
      }

      // Admin pages
      if (path.startsWith('/admin')) {
        const username = await verifySession(request, env);
        if (!username) return Response.redirect(new URL('/login', request.url).toString(), 302);

        // Admin page (entries)
        if (path === '/admin/entries') {
          const entries = await env.DB.prepare(
            'SELECT * FROM entries ORDER BY created_at DESC LIMIT 100'
          ).all();
          
          return new Response(getAdminEntriesHTML(entries.results || [], config), {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        if (path === '/admin/entries/edit') {
          const entryId = parseInt(url.searchParams.get('entry') || '', 10);
          if (!Number.isInteger(entryId) || entryId <= 0) {
            return new Response('Invalid entry ID', { status: 400 });
          }

          const entry = await env.DB.prepare(
            'SELECT id, status, created_at FROM entries WHERE id = ? LIMIT 1'
          ).bind(entryId).first();

          if (!entry) {
            return new Response('Entry not found', { status: 404 });
          }

          return new Response(getAdminEditEntryHTML(entry, config), {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        if (path === '/admin/embed') {
          // Use configured API_URL or fallback to current origin
          const apiUrl = config.API_URL ? config.API_URL.replace(/\/$/, '') : url.origin;
          return new Response(getEmbedHTML(config, apiUrl), {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        if (path === '/admin/media') {
          const mediaBucket = getMediaBucket(env);
          let mediaObjects = [];
          if (mediaBucket) {
            try {
              const listed = await mediaBucket.list({ limit: MEDIA_LIST_LIMIT });
              mediaObjects = (listed.objects || []).slice().sort(function(a, b) {
                return String(b.uploaded || '').localeCompare(String(a.uploaded || ''));
              });
            } catch (e) {
              console.error('R2 list failed', e);
            }
          }
          const mediaPublicBase = (config.CANONICAL_URL || config.API_URL || url.origin).replace(/\/$/, '');
          return new Response(getAdminMediaHTML(config, mediaObjects, !!mediaBucket, mediaPublicBase), {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        if (path === '/admin/settings') {
          return new Response(getSettingsHTML(config), {
            headers: { 'Content-Type': 'text/html' }
          });
        }

        // Default admin page (post)
        return new Response(getAdminPostHTML(config), {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      // Client script
      if (path === '/client.js') {
        const allowedOrigin = getAllowedOrigin(request, env);
        return new Response(getClientScript(config, request.url), {
          headers: Object.assign(
            { 'Content-Type': 'application/javascript' },
            allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}
          )
        });
      }

      // Protected data export (JSON)
      if (path === '/data.json') {
        const username = await verifySession(request, env);
        if (!username) return Response.redirect(new URL('/login', request.url).toString(), 302);

        const entries = await env.DB.prepare(
          'SELECT id, status, created_at FROM entries ORDER BY created_at DESC'
          
        ).all();
        
        const results = (entries.results || []).map(entry => ({
          ...entry,
          created_at: entry.created_at ? entry.created_at.replace(' ', 'T') + 'Z' : null
        }));
        
        return new Response(JSON.stringify(results, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, no-store'
          }
        });
      }

      // Protected data export (CSV)
      if (path === '/data.csv') {
        const username = await verifySession(request, env);
        if (!username) return Response.redirect(new URL('/login', request.url).toString(), 302);

        const entries = await env.DB.prepare(
          'SELECT id, status, created_at FROM entries ORDER BY created_at DESC'
          
        ).all();
        
        const results = entries.results || [];
        
        // CSV Header
        let csv = 'ID,Status,Date\n';
        
        // CSV Rows
        for (const entry of results) {
          const status = (entry.status || '').replace(/"/g, '""');
          let date = (entry.created_at || '').replace(/"/g, '""');
          
          // Convert to ISO 8601 UTC format (YYYY-MM-DDTHH:MM:SSZ)
          if (date && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) {
            date = date.replace(' ', 'T') + 'Z';
          }
          
          csv += `"${entry.id}","${status}","${date}"\n`;
        }
        
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="status-data.csv"',
            'Cache-Control': 'private, no-store'
          }
        });
      }

      // Single status page: /<id>
      const statusPathMatch = path.match(/^\/(\d+)$/);
      if (statusPathMatch) {
        const statusId = parseInt(statusPathMatch[1], 10);
        const entry = await env.DB.prepare(
          'SELECT id, status, created_at FROM entries WHERE id = ? LIMIT 1'
        ).bind(statusId).first();

        if (!entry) {
          return new Response('Not Found', { status: 404 });
        }

        return new Response(getSingleStatusHTML(entry, config), {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=60, s-maxage=60'
          }
        });
      }

      // Index page
      if (path === '/') {
        const entries = await env.DB.prepare(
          'SELECT id, status, created_at FROM entries ORDER BY id DESC LIMIT ?'
        ).bind(ENTRIES_PAGE_LIMIT).all();
        
        return new Response(getIndexHTML(entries.results || [], config, url.hostname), {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=60, s-maxage=60'
          }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
