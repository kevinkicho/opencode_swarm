import net from 'node:net';
import { spawn } from 'node:child_process';

const pickPort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const port = await pickPort();
spawn('next', ['dev', '-p', String(port)], { stdio: 'inherit', shell: true });
