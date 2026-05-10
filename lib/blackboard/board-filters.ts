import type { BoardItem } from '@/lib/blackboard/types';

export type BoardFilter = {
  status?: string[];   // 'open' | 'in-progress' | 'done' | 'stale'
  kind?: string[];     // 'todo' | 'criterion' | 'finding'
  search?: string;     // case-insensitive substring in content
};

export function applyBoardFilters(items: BoardItem[], filter: BoardFilter): BoardItem[] {
  return items.filter((item) => {
    if (filter.status && filter.status.length > 0 && !filter.status.includes(item.status)) {
      return false;
    }
    if (filter.kind && filter.kind.length > 0 && !filter.kind.includes(item.kind)) {
      return false;
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!item.content.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });
}
