/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--color-ink-muted) / <alpha-value>)',
        'ink-subtle': 'rgb(var(--color-ink-subtle) / <alpha-value>)',
        canvas: 'rgb(var(--color-canvas) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-card': 'rgb(var(--color-surface-card) / <alpha-value>)',
        'surface-soft': 'rgb(var(--color-surface-soft) / <alpha-value>)',
        hairline: 'rgb(var(--color-hairline) / <alpha-value>)',
        'hairline-soft': 'rgb(var(--color-hairline-soft) / <alpha-value>)',
        clay: 'rgb(var(--color-clay) / <alpha-value>)',
        'clay-active': 'rgb(var(--color-clay-active) / <alpha-value>)',
        'clay-ink': 'rgb(var(--color-clay-ink) / <alpha-value>)',
        sky: 'rgb(var(--color-sky) / <alpha-value>)',
        moss: 'rgb(var(--color-moss) / <alpha-value>)',
        sage: 'rgb(var(--color-sage) / <alpha-value>)',
        golden: 'rgb(var(--color-golden) / <alpha-value>)',
        crimson: 'rgb(var(--color-crimson) / <alpha-value>)',
        'crimson-light': 'rgb(var(--color-crimson-light) / <alpha-value>)',
      },
      fontFamily: {
        serif: ['Lora', 'Georgia', 'Source Serif Pro', 'Charter', 'serif'],
        sans: ['Poppins', 'Inter', 'system-ui', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      fontSize: {
        xs: ['12px', { lineHeight: '16px', letterSpacing: '-0.01em' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '20px' }],
        lg: ['16px', { lineHeight: '24px' }],
        xl: ['18px', { lineHeight: '26px' }],
        '2xl': ['20px', { lineHeight: '28px' }],
      },
      boxShadow: {
        none: 'none',
      },
    },
  },
  plugins: [],
};
