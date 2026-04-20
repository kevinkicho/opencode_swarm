import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (p: IconProps) => ({
  width: p.size ?? 16,
  height: p.size ?? 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
});

/* Fluent System Icons - Regular weight, 24x24 grid */

export const IconRead = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 3h8l5 5v13H6z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 16.5h4.5" />
  </svg>
);

export const IconEdit = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20h4.5L20 8.5 15.5 4 4 15.5z" />
    <path d="M13.5 6l4.5 4.5" />
  </svg>
);

export const IconWrite = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 3h9l5 5v13H5z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </svg>
);

export const IconBash = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
    <path d="M7 10l3 2-3 2" />
    <path d="M13 15h4" />
  </svg>
);

export const IconGrep = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M20 20l-5-5" />
  </svg>
);

export const IconGlob = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 4h6v6H4zM14 14h6v6h-6z" />
    <path d="M14 4h6v6h-6z" strokeDasharray="1.5 2" />
    <path d="M4 14h6v6H4z" strokeDasharray="1.5 2" />
  </svg>
);

export const IconWebFetch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.8 3 2.8 14 0 17M12 3.5c-2.8 3-2.8 14 0 17" />
  </svg>
);

export const IconAgent = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M4 9h16" />
    <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconThinking = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" opacity="0.6" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" opacity="0.6" />
  </svg>
);

export const IconUser = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20c1.5-3.4 4.2-5 7.5-5s6 1.6 7.5 5" />
  </svg>
);

export const IconDecision = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l9 9-9 9-9-9z" />
    <path d="M12 8v4" />
    <circle cx="12" cy="15.5" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMilestone = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 2.5l2.4 6.8h7l-5.7 4.2 2.2 6.8L12 16l-5.9 4.3 2.2-6.8L2.6 9.3h7z" />
  </svg>
);

export const IconSearch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20.5 20.5L16 16" />
  </svg>
);

export const IconFilter = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 5h16l-6 8v5l-4 2v-7z" />
  </svg>
);

export const IconPlus = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconChevron = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const IconChevronDown = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 9l7 7 7-7" />
  </svg>
);

export const IconBranch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 7v10" />
    <path d="M6 14c0-3 3-5 6-5h4" />
  </svg>
);

export const IconSpark = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l1.4 4.4L18 9l-4.6 1.6L12 15l-1.4-4.4L6 9l4.6-1.6z" />
    <path d="M19 16l.6 1.8L21 18.5l-1.4.6-.6 1.9-.6-1.9-1.4-.6 1.4-.7z" />
  </svg>
);

export const IconDot = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="12" cy="12" r="3.5" />
  </svg>
);

export const IconTerminal = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M7 10l3 2-3 2M12 14h5" />
  </svg>
);

export const IconLogo = (p: IconProps) => (
  <svg {...base(p)} viewBox="0 0 24 24">
    <path d="M4 6L12 2l8 4v12l-8 4-8-4z" />
    <path d="M12 2v20M4 6l16 12M20 6L4 18" strokeOpacity="0.35" strokeWidth="1" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSettings = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.5 12H2.3M21.7 12h-2.2M6.5 6.5L5 5M19 19l-1.5-1.5M6.5 17.5L5 19M19 5l-1.5 1.5" />
  </svg>
);

export const IconMore = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="6" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18" cy="12" r="1.6" />
  </svg>
);

export const IconPanel = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M15 4v16" />
  </svg>
);

export const IconSend = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12l18-8-6 18-3-7z" />
    <path d="M12 15l3-7" />
  </svg>
);

/* Windows 11 caption button glyphs - thin 1px strokes, 10x10 effective */

export const IconWinMinimize = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={1}>
    <path d="M5 12h14" />
  </svg>
);

export const IconWinMaximize = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={1}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="0.5" />
  </svg>
);

export const IconWinRestore = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={1}>
    <rect x="5.5" y="8.5" width="10" height="10" rx="0.5" />
    <path d="M8.5 8.5V5.5H18.5V15.5H15.5" />
  </svg>
);

export const IconWinClose = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={1}>
    <path d="M6 6l12 12M6 18L18 6" />
  </svg>
);

export function toolIcon(kind?: string) {
  switch (kind) {
    case 'read':
      return IconRead;
    case 'edit':
      return IconEdit;
    case 'write':
      return IconWrite;
    case 'bash':
      return IconBash;
    case 'grep':
      return IconGrep;
    case 'glob':
      return IconGlob;
    case 'webfetch':
      return IconWebFetch;
    default:
      return IconDot;
  }
}
