import 'server-only';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Convert Windows path to WSL mount for Node reads.
function toNodeReadable(p: string): string {
  const m = p.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

export interface PackageInfo {
  name: string;
  path: string;
  description?: string;
  dependencies?: string[];
}

export async function discoverPackages(workspace: string): Promise<PackageInfo[]> {
  const root = toNodeReadable(workspace);
  const packages: PackageInfo[] = [];

  // Check top-level package.json
  const rootPkgPath = path.join(root, 'package.json');
  if (existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(rootPkgPath, 'utf8'));
      packages.push({
        name: pkg.name || path.basename(workspace),
        path: '.',
        description: pkg.description,
        dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
      });
    } catch { /* skip */ }
  }

  // Check for workspaces / monorepo packages
  const workspaceDirs = ['packages', 'apps', 'libs', 'services'];
  for (const dir of workspaceDirs) {
    const dirPath = path.join(root, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(dirPath, entry.name, 'package.json');
        if (!existsSync(pkgPath)) continue;
        try {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
          packages.push({
            name: pkg.name || entry.name,
            path: path.join(dir, entry.name),
            description: pkg.description,
            dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
          });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return packages;
}

export function buildPackageMap(packages: PackageInfo[]): string {
  if (packages.length <= 1) return '';

  const lines = ['## Substrate Map — Workspace Packages', ''];
  for (const pkg of packages) {
    const deps = pkg.dependencies && pkg.dependencies.length > 0
      ? ` (depends on: ${pkg.dependencies.slice(0, 5).join(', ')})`
      : '';
    lines.push(`- **${pkg.name}** (${pkg.path})${pkg.description ? ': ' + pkg.description : ''}${deps}`);
  }
  lines.push('');
  lines.push('When proposing work, specify which package each todo targets via [files:path/to/file].');
  lines.push('Cross-package changes are valid but should be explicit.');
  return lines.join('\n');
}
