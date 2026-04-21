// Sticky random port: pick once, reuse forever.
// First run rolls a random port in the ephemeral range and writes it to
// `.dev-port`; subsequent runs read that file. This stays off well-known
// ports (so nothing else on the box collides by convention) while keeping
// the URL identical across restarts, so a bookmarked tab keeps working.
// Delete `.dev-port` to reroll. Override with DEV_PORT=xxxx for one-shots.
import net from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PORT_FILE = '.dev-port';
const MIN = 49152;
const MAX = 65535;

const isFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });

async function rollPort() {
  for (let i = 0; i < 20; i++) {
    const candidate = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error('could not find a free port after 20 tries');
}

async function resolvePort() {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT);
  if (existsSync(PORT_FILE)) {
    const saved = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isInteger(saved) && saved >= MIN && saved <= MAX && (await isFree(saved))) {
      return saved;
    }
  }
  const picked = await rollPort();
  writeFileSync(PORT_FILE, String(picked));
  return picked;
}

const port = await resolvePort();
console.log(`\n[dev] using port ${port} (from ${PORT_FILE} — delete to reroll)\n`);
spawn('next', ['dev', '-p', String(port)], { stdio: 'inherit', shell: true });
