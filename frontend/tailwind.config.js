/** @type {import('tailwindcss').Config} */
// Colours are AssetWise "Attune" tokens, declared once as CSS variables in
// index.html's :root and referenced here, so a class like bg-primary and a
// Chart.js call reading getCSS('--primary') always agree.
module.exports = {
  content: ['./index.html', './debug.html'],
  theme: {
    extend: {
      colors: {
        primary:    'var(--primary)',
        positive:   'var(--positive)',
        negative:   'var(--negative)',
        amber:      'var(--amber)',
        teal:       'var(--teal)',
        background: 'var(--background)',
        surface:    'var(--surface)',
        'surface-sunken': 'var(--surface-sunken)',
        accent:     'var(--accent)',
        'accent-foreground': 'var(--accent-foreground)',
        card:       'var(--card)',
        border:     'var(--border)',
        text:       'var(--text)',
        muted:      'var(--muted)',
        'evt-rate':  'var(--evt-rate)',
        'evt-corp':  'var(--evt-corp)',
        'evt-pol':   'var(--evt-pol)',
        'evt-proj':  'var(--evt-proj)',
        'evt-macro': 'var(--evt-macro)',
        'evt-other': 'var(--evt-other)',
        'sidebar-bg':     'var(--sidebar-bg)',
        'sidebar-text':   'var(--sidebar-text)',
        'sidebar-muted':  'var(--sidebar-muted)',
        'sidebar-active': 'var(--sidebar-active)',
        'sidebar-active-text': 'var(--sidebar-active-text)',
        'sidebar-hover':  'var(--sidebar-hover)',
        'sidebar-border': 'var(--sidebar-border)',
      },
      // IBM Plex Sans Thai carries both scripts, so `sans` (body, Latin) and
      // `thai` (the .th class) resolve to the same face — Thai and Latin set
      // side by side in one line share a baseline and weight instead of
      // switching typefaces mid-sentence as Inter + Sarabun did.
      // Anuphan is for headings only; Plex Mono is for numbers that must line
      // up (prices, KPIs, table columns).
      fontFamily: {
        sans:    ['"IBM Plex Sans Thai"', '-apple-system', 'system-ui', 'sans-serif'],
        thai:    ['"IBM Plex Sans Thai"', '-apple-system', 'system-ui', 'sans-serif'],
        heading: ['Anuphan', '"IBM Plex Sans Thai"', 'sans-serif'],
        mono:    ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        control: '8px',   // anything you can press
        card:    '12px',  // cards, panels, dialogs
      },
    },
  },
  plugins: [],
};
