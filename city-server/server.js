'use strict';
// CITY — servidor multiplayer (sem dependências). Rode: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SENHA = String(process.env.ADM_SENHA || '2600');               // senha do ADM
const ABERTO = process.env.ABERTO === '1';                            // ABERTO=1 -> qualquer nome entra, sem código
const APROVADOS = (process.env.APROVADOS || 'dj_guilherme_br_oficial')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);       // nomes que entram sem código
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');

try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
const PF = path.join(DATA, 'pessoas.json');
let pessoas = [];
try { pessoas = JSON.parse(fs.readFileSync(PF, 'utf8')); } catch (e) {}
const salvaPessoas = () => { try { fs.writeFileSync(PF, JSON.stringify(pessoas)); } catch (e) {} };

const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('var SERVER=false', 'var SERVER=true');

const admTokens = new Set();
const tokens = new Map();               // token -> {u}
let evSeq = 0, evPersist = { t: 0, tipo: 'parar' };
const players = new Map();              // id -> player
let nextId = 1;

const rnd = () => crypto.randomBytes(18).toString('hex');
const limpaNome = s => String(s || '').replace(/^@/, '').replace(/[^\w.]/g, '').slice(0, 30);

// ---------- HTTP ----------
function lerCorpo(req, cb) {
  let b = '', estourou = false;
  req.on('data', d => { b += d; if (b.length > 300000) { estourou = true; req.destroy(); } });
  req.on('end', () => { if (estourou) return; let j = {}; try { j = JSON.parse(b || '{}'); } catch (e) {} cb(j); });
}
function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const admOk = t => typeof t === 'string' && admTokens.has(t);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;

  if (m === 'GET' && (p === '/' || p === '/index.html' || p === '/City.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(HTML);
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/api/moradores') return json(res, []);     // jogadores reais vêm pelo WebSocket

  if (p === '/api/adm' && m === 'POST') return lerCorpo(req, b => {
    const a = Buffer.from(String(b.senha || '')), s = Buffer.from(SENHA);
    const ok = a.length === s.length && crypto.timingSafeEqual(a, s);
    if (!ok) return setTimeout(() => json(res, { adm: null }), 500);
    const t = rnd(); admTokens.add(t); json(res, { adm: t });
  });

  if (p === '/api/evento' && m === 'GET') return json(res, evPersist);
  if (p === '/api/evento' && m === 'POST') return lerCorpo(req, b => {
    if (!admOk(b.adm)) return json(res, { erro: 'sem permissão' }, 403);
    const tipo = String(b.tipo || '');
    if (!/^[\w|.\-]{1,60}$/.test(tipo)) return json(res, { erro: 'evento inválido' }, 400);
    evSeq++;
    if (/^(festa|luzes|parar)/.test(tipo)) evPersist = { t: evSeq, tipo };
    broadcast({ t: 'ev', n: evSeq, tipo });
    json(res, { ok: true, t: evSeq });
  });

  if (p === '/api/pessoas' && m === 'GET') {
    if (!admOk(u.searchParams.get('adm'))) return json(res, { erro: 'sem permissão' }, 403);
    return json(res, pessoas);
  }
  if (p === '/api/pessoas' && m === 'PUT') return lerCorpo(req, b => {
    if (!admOk(b.adm)) return json(res, { erro: 'sem permissão' }, 403);
    const l = Array.isArray(b.lista) ? b.lista.slice(0, 500) : [];
    pessoas = l.map(x => ({ u: limpaNome(x && x.u).toLowerCase(), c: String((x && x.c) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) }))
               .filter(x => x.u && x.c);
    salvaPessoas(); json(res, { ok: true });
  });

  if (p === '/api/entrar' && m === 'POST') return lerCorpo(req, b => {
    const nome = limpaNome(b.u), cod = String(b.codigo || '').trim().toUpperCase(), low = nome.toLowerCase();
    if (!nome) return json(res, { erro: 'Digite seu nome.' });
    const ok = ABERTO || APROVADOS.includes(low) || pessoas.some(x => x.u === low && x.c === cod);
    if (!ok) return json(res, { erro: cod ? 'Código inválido.' : 'Seu nome não está na lista. Coloque o código para entrar.', codigo: true });
    const token = rnd(); tokens.set(token, { u: nome });
    json(res, { token, u: nome });
  });

  if (p === '/api/sair' && m === 'POST') return lerCorpo(req, b => {
    const tk = String(b.token || '');
    for (const pl of [...players.values()]) if (pl.tk === tk) quit(pl);
    tokens.delete(tk); json(res, { ok: true });
  });

  res.writeHead(404); res.end('não encontrado');
});

// ---------- WebSocket mínimo ----------
function frame(op, payload) {
  const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload), n = pl.length;
  let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, pl]);
}
function enviar(pl, obj) { if (!pl.sock.destroyed) try { pl.sock.write(frame(1, JSON.stringify(obj))); } catch (e) {} }
function broadcast(obj, exceto) {
  const f = frame(1, JSON.stringify(obj));
  for (const pl of players.values()) if (pl.joined && pl !== exceto && !pl.sock.destroyed) try { pl.sock.write(f); } catch (e) {}
}
function quit(pl) {
  if (!players.delete(pl.id)) return;
  try { pl.sock.destroy(); } catch (e) {}
  if (pl.joined) broadcast({ t: 'out', id: pl.id });
}
const num = (v, a, b) => { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, v)) : 0; };

function onMsg(pl, txt) {
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (m.t === 'j' && !pl.joined) {
    const f = String(m.f || '');
    pl.foto = f.startsWith('data:image/') && f.length < 60000 ? f : '';
    pl.joined = true;
    const outros = [...players.values()].filter(o => o !== pl && o.joined);
    enviar(pl, { t: 'h', id: pl.id, j: outros.map(o => ({ id: o.id, u: o.u, f: o.foto })), ev: evPersist });
    const snap = outros.filter(o => o.st).map(o => [o.id, ...o.st]);
    if (snap.length) enviar(pl, { t: 's', p: snap });
    broadcast({ t: 'in', id: pl.id, u: pl.u, f: pl.foto }, pl);
  } else if (m.t === 'p' && pl.joined && Array.isArray(m.s)) {
    const s = m.s;
    pl.st = [+num(s[0], -120, 120).toFixed(2), +num(s[1], -5, 80).toFixed(2), +num(s[2], -120, 120).toFixed(2),
             +num(s[3], -20, 20).toFixed(2), s[4] ? 1 : 0, Math.round(num(s[5], -1, 99)), Math.round(num(s[6], 0, 1))];
    pl.dirty = true;
  } else if (m.t === 'w' && pl.joined) {
    broadcast({ t: 'w', id: pl.id }, pl);
  }
}

function onData(pl, d) {
  pl.last = Date.now();
  pl.buf = Buffer.concat([pl.buf, d]);
  if (pl.buf.length > 400000) return quit(pl);
  for (;;) {
    const b = pl.buf;
    if (b.length < 2) return;
    const op = b[0] & 15, masked = b[1] & 128;
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 120000) return quit(pl);
    const mo = masked ? 4 : 0;
    if (b.length < off + mo + len) return;
    let body = b.slice(off + mo, off + mo + len);
    if (masked) { const k = b.slice(off, off + 4); body = Buffer.from(body); for (let i = 0; i < body.length; i++) body[i] ^= k[i & 3]; }
    pl.buf = b.slice(off + mo + len);
    if (op === 8) return quit(pl);
    if (op === 9) { try { pl.sock.write(frame(10, body)); } catch (e) {} }
    else if (op === 1) onMsg(pl, body.toString('utf8'));
  }
}

server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x'), info = tokens.get(u.searchParams.get('token')), key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !info || !key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  for (const o of [...players.values()]) if (o.u.toLowerCase() === info.u.toLowerCase()) quit(o);   // reconexão substitui a antiga
  const pl = { id: nextId++, u: info.u, tk: u.searchParams.get('token'), sock, buf: Buffer.alloc(0), foto: '', st: null, dirty: false, joined: false, last: Date.now() };
  players.set(pl.id, pl);
  sock.on('data', d => onData(pl, d));
  sock.on('close', () => quit(pl));
  sock.on('error', () => quit(pl));
});

// posições: 10x por segundo, só de quem mexeu
setInterval(() => {
  const mud = [];
  for (const pl of players.values()) if (pl.dirty && pl.st) { pl.dirty = false; mud.push([pl.id, ...pl.st]); }
  if (mud.length) broadcast({ t: 's', p: mud });
}, 100);
// remove quem sumiu sem avisar
setInterval(() => { const agora = Date.now(); for (const pl of [...players.values()]) if (agora - pl.last > 20000) quit(pl); }, 5000);

server.listen(PORT, () => console.log('CITY no ar: http://localhost:' + PORT + '  (senha ADM: ' + (process.env.ADM_SENHA ? 'definida por ADM_SENHA' : '2600 — troque com ADM_SENHA') + ')'));
