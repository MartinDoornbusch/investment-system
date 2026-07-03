/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "navy" used for headings — remapped to bright text for dark theme
        navy: '#e6edf3',
        // brandblue for links, CTAs, focus rings
        brandblue: '#58a6ff',
        // dark surface layers
        surface: '#161b22',
        'surface-2': '#1c2128',
        // border shades
        border: '#30363d',
        'border-subtle': '#21262d',
        // muted / secondary text
        dim: '#8b949e',
      },
    },
  },
  plugins: [],
}
