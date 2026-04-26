// Heat-rail tree builder + flattener.
//
// Pure functions over FileHeat[] → TreeNode (hierarchical) → FlatRow[]
// (visit order respecting expand/collapse state). Extracted from
// heat-rail.tsx in #108 so the tree shape is reusable + testable in
// isolation.

import type { FileHeat } from '@/lib/opencode/transform';
import { stripWorkspace } from './utils';

export interface TreeNode {
  type: 'dir' | 'file';
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  editCount: number;
  lastTouchedMs: number;
  fileCount: number;
  heat?: FileHeat;
}

export function buildTree(
  heat: FileHeat[],
  workspace: string,
  coldPaths: readonly string[] | null = null,
): TreeNode {
  const root: TreeNode = {
    type: 'dir',
    name: '/',
    fullPath: '',
    children: new Map(),
    editCount: 0,
    lastTouchedMs: 0,
    fileCount: 0,
  };

  for (const h of heat) {
    const stripped = stripWorkspace(h.path, workspace);
    const segments = stripped.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const isLeaf = i === segments.length - 1;
      const seg = segments[i];
      let next = cursor.children.get(seg);
      if (!next) {
        next = {
          type: isLeaf ? 'file' : 'dir',
          name: seg,
          fullPath: segments.slice(0, i + 1).join('/'),
          children: new Map(),
          editCount: 0,
          lastTouchedMs: 0,
          fileCount: 0,
          heat: isLeaf ? h : undefined,
        };
        cursor.children.set(seg, next);
      }
      cursor = next;
    }
  }

  if (coldPaths) {
    for (const rel of coldPaths) {
      const segments = rel.split('/').filter(Boolean);
      if (segments.length === 0) continue;
      let cursor = root;
      let alreadyHot = false;
      for (let i = 0; i < segments.length; i += 1) {
        const isLeaf = i === segments.length - 1;
        const seg = segments[i];
        let next = cursor.children.get(seg);
        if (!next) {
          next = {
            type: isLeaf ? 'file' : 'dir',
            name: seg,
            fullPath: segments.slice(0, i + 1).join('/'),
            children: new Map(),
            editCount: 0,
            lastTouchedMs: 0,
            fileCount: 0,
          };
          cursor.children.set(seg, next);
        } else if (isLeaf && next.heat) {
          alreadyHot = true;
        }
        cursor = next;
        if (alreadyHot) break;
      }
    }
  }

  function aggregate(node: TreeNode): void {
    if (node.type === 'file' && node.heat) {
      node.editCount = node.heat.editCount;
      node.lastTouchedMs = node.heat.lastTouchedMs;
      node.fileCount = 1;
      return;
    }
    let count = 0;
    let last = 0;
    let files = 0;
    for (const child of node.children.values()) {
      aggregate(child);
      count += child.editCount;
      if (child.lastTouchedMs > last) last = child.lastTouchedMs;
      files += child.fileCount;
    }
    node.editCount = count;
    node.lastTouchedMs = last;
    node.fileCount = files;
  }
  aggregate(root);
  return root;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

export function flattenTree(
  root: TreeNode,
  expanded: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  function visit(node: TreeNode, depth: number): void {
    if (node !== root) {
      out.push({ node, depth });
    }
    if (node.type === 'dir' && (node === root || expanded.has(node.fullPath))) {
      const kids = [...node.children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        if (b.editCount !== a.editCount) return b.editCount - a.editCount;
        return a.name.localeCompare(b.name);
      });
      for (const kid of kids) visit(kid, depth + 1);
    }
  }
  visit(root, -1);
  return out;
}
