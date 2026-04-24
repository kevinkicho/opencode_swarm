// Cross-platform wrapper for `ANALYZE=true next build`.
//
// Can't just use a bare "ANALYZE=true next build" npm script because that
// doesn't work on Windows cmd.exe (needs `set ANALYZE=true && ...` there).
// Node's spawn with an explicit env object works everywhere.
//
// After the build completes @next/bundle-analyzer opens two HTML reports
// in the default browser: one for the client bundle, one for the server
// (edge) bundle. Reports land in .next/analyze/.

import { spawn } from 'node:child_process';

const child = spawn('next', ['build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ANALYZE: 'true' },
});
child.on('exit', (code) => process.exit(code ?? 0));
