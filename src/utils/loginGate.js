import crypto from 'crypto';

/**
 * Lightweight password gate. Single shared password (LOGIN_PASSWORD env var).
 * A SHA-256(password + LOGIN_SALT) value lives in the `tts_auth` cookie;
 * middleware checks for an exact match before allowing requests through.
 * Not a security boundary — just keeps the demo behind a "knock knock".
 */

const COOKIE_NAME = 'tts_auth';
const ALLOWLIST = new Set(['/login', '/api/login', '/favicon.ico', '/styles.css']);

function expectedToken() {
    const password = process.env.LOGIN_PASSWORD;
    if (!password) return null;
    const salt = process.env.LOGIN_SALT || 'tts-comparison-default-salt';
    return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === name) return rest.join('=');
    }
    return null;
}

function isAuthenticated(req) {
    const token = expectedToken();
    if (!token) return true; // no password configured — gate disabled
    return getCookie(req, COOKIE_NAME) === token;
}

export function loginGate(req, res, next) {
    if (ALLOWLIST.has(req.path)) return next();
    if (isAuthenticated(req)) return next();

    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
        return res.redirect('/login');
    }
    return res.status(401).json({ error: 'auth required' });
}

export function handleLoginPost(req, res) {
    const expected = expectedToken();
    if (!expected) {
        return res.status(500).json({ error: 'LOGIN_PASSWORD not configured on server' });
    }
    const submitted = (req.body?.password || '').toString();
    if (submitted !== process.env.LOGIN_PASSWORD) {
        return res.status(401).json({ error: 'incorrect password' });
    }
    // 30-day cookie, httpOnly, sameSite=Lax. Don't set Secure so this works on http://localhost.
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    res.json({ ok: true });
}

export function serveLoginPage(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTS Comparison · Sign in</title>
    <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0b0e14;
            color: #e6e9ef;
        }
        form {
            display: grid;
            gap: 16px;
            background: #141925;
            border: 1px solid #2a3144;
            padding: 32px;
            border-radius: 12px;
            min-width: 320px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.4);
        }
        h1 {
            margin: 0 0 4px;
            font-size: 18px;
            font-weight: 600;
            letter-spacing: -0.01em;
        }
        p.subtitle { margin: 0 0 12px; font-size: 13px; color: #8a93a6; }
        input[type="password"] {
            padding: 12px 14px;
            border: 1px solid #2a3144;
            background: #0b0e14;
            color: #e6e9ef;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
        }
        input[type="password"]:focus { border-color: #6a87ff; }
        button {
            padding: 12px 14px;
            border: none;
            background: #6a87ff;
            color: white;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
        }
        button:hover { background: #587cff; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .error { color: #ff7676; font-size: 13px; min-height: 18px; }
    </style>
</head>
<body>
    <form id="loginForm" autocomplete="off">
        <h1>TTS Comparison</h1>
        <p class="subtitle">Enter the password to continue.</p>
        <input id="pw" type="password" placeholder="Password" autofocus required>
        <div class="error" id="err"></div>
        <button type="submit" id="submit">Sign in</button>
    </form>
    <script>
        const form = document.getElementById('loginForm');
        const err = document.getElementById('err');
        const submit = document.getElementById('submit');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            err.textContent = '';
            submit.disabled = true;
            try {
                const r = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: document.getElementById('pw').value })
                });
                if (r.ok) {
                    window.location.href = '/';
                    return;
                }
                const data = await r.json().catch(() => ({}));
                err.textContent = data.error || 'Sign in failed';
            } catch (e) {
                err.textContent = 'Network error';
            } finally {
                submit.disabled = false;
            }
        });
    </script>
</body>
</html>`);
}
