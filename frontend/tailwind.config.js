/** @type {import('tailwindcss').Config} */
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
        surface:    'var(--surface)',
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
        'sidebar-border': 'var(--sidebar-border)',
      },
      fontFamily: {
        thai: ['Sarabun', 'Inter', 'sans-serif'],
        sans: ['Inter', 'Sarabun', '-apple-system', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
