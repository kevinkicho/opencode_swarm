// Fixed default port so the URL is the same every run — makes it easy to
// bookmark, keep a browser tab pinned, and reason about "is the server up?"
// without hunting a new port number every time. Override with DEV_PORT=xxxx
// if another process is already bound.
import { spawn } from 'node:child_process';

const port = process.env.DEV_PORT ?? '3000';
spawn('next', ['dev', '-p', port], { stdio: 'inherit', shell: true });
