import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#05070b',
          900: '#07090d',
          850: '#0a0d12',
          800: '#0f131a',
          750: '#141923',
          700: '#1a1f2b',
          600: '#232a37',
          550: '#2a3240',
          500: '#353e4e',
          400: '#49556a',
        },
        fog: {
          50: '#f4f6fa',
          100: '#e8ecf2',
          200: '#d2d9e5',
          300: '#b8c1cf',
          400: '#9ba5b5',
          500: '#7d8798',
          600: '#5b6576',
          700: '#434b5a',
          800: '#2f3645',
        },
        molten: {
          DEFAULT: '#ff7a3d',
          soft: '#ff9566',
          dim: '#b5552a',
          glow: '#ff7a3d33',
        },
        mint: {
          DEFAULT: '#5eead4',
          soft: '#8bf0df',
          dim: '#3c9a8b',
        },
        iris: {
          DEFAULT: '#c084fc',
          soft: '#d3a6fd',
          dim: '#8453b0',
        },
        amber: {
          DEFAULT: '#fbbf24',
        },
        rust: {
          DEFAULT: '#f87171',
          dim: '#a94f4f',
        },
        sky: {
          DEFAULT: '#38bdf8',
          dim: '#2a7ba8',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        micro: ['0.625rem', { lineHeight: '0.875rem', letterSpacing: '0.04em' }],
      },
      letterSpacing: {
        wider2: '0.08em',
        widest2: '0.14em',
      },
      boxShadow: {
        'glow-molten': '0 0 0 1px rgba(255,122,61,0.25), 0 0 24px -4px rgba(255,122,61,0.35)',
        'glow-mint': '0 0 0 1px rgba(94,234,212,0.25), 0 0 24px -6px rgba(94,234,212,0.3)',
        'glow-iris': '0 0 0 1px rgba(192,132,252,0.25), 0 0 24px -6px rgba(192,132,252,0.3)',
        'card': '0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 30px -12px rgba(0,0,0,0.6)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(255,122,61,0.5)' },
          '80%, 100%': { boxShadow: '0 0 0 10px rgba(255,122,61,0)' },
        },
        'urgent-pulse': {
          '0%': { boxShadow: '0 0 0 0 rgba(245,158,11,0.75)' },
          '70%, 100%': { boxShadow: '0 0 0 8px rgba(245,158,11,0)' },
        },
        'retry-pulse': {
          '0%': { boxShadow: '0 0 0 0 rgba(248,113,113,0.7)' },
          '12%': { boxShadow: '0 0 0 5px rgba(248,113,113,0)' },
          '20%': { boxShadow: '0 0 0 0 rgba(248,113,113,0.7)' },
          '32%': { boxShadow: '0 0 0 5px rgba(248,113,113,0)' },
          '100%': { boxShadow: '0 0 0 5px rgba(248,113,113,0)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.6s cubic-bezier(0.4,0,0.6,1) infinite',
        'urgent-pulse': 'urgent-pulse 1s cubic-bezier(0.4,0,0.6,1) infinite',
        'retry-pulse': 'retry-pulse 1.4s ease-out infinite',
        'fade-up': 'fade-up 0.5s ease-out both',
        'scan': 'scan 4s linear infinite',
        'shimmer': 'shimmer 2.4s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
