# --- Stage 1: builder ---
# Install ALL deps (incl. tailwindcss/postcss devDependencies) and compile
# the minified CSS into frontend/dist/styles.css. Backend code, frontend
# HTML, and sample_data.js are copied into the image here too so the
# runtime stage only needs to layer prod-only deps on top.
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first so this layer caches as long as deps don't change.
COPY package.json package-lock.json ./

# `npm ci` requires package-lock.json; installs both deps and devDependencies
# so tailwindcss/postcss/autoprefixer are available for the CSS build.
RUN npm ci --no-audit --no-fund

# Copy the rest of the source the build needs (frontend HTML + src for
# tailwind's content scan, backend for completeness).
COPY frontend ./frontend
COPY backend ./backend
COPY sample_data.js ./sample_data.js

# Build the minified Tailwind CSS bundle that index.html references as
# `dist/styles.css`. This is the only artifact the builder produces; the
# runtime stage re-uses it from frontend/dist/styles.css.
RUN npm run build:css

# --- Stage 2: runtime ---
# Slim image: only prod deps + the files needed to serve. No tailwind CLI,
# no postcss config, no source CSS — just the pre-built bundle.
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Reinstall, prod-only this time. Skipping devDependencies drops tailwindcss
# (~MBs) and other build-only packages from the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy the prebuilt CSS, frontend (HTML + dist/), backend (server.js + db.js +
# lib/ + migrate-*.js), and sample_data.js (used by seedFromSampleData() in
# server.js when the DB is empty and Postgres is unreachable).
COPY --from=builder /app/frontend ./frontend
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/sample_data.js ./sample_data.js

# Railway injects PORT at runtime; server.js already honors it
# (process.env.PORT || 3000). Use the same default here for parity.
ENV PORT=3000
EXPOSE 3000

# Run as the unprivileged `node` user that ships with the official image —
# root-in-a-container is a needless attack surface, especially for a service
# that talks to Postgres + Yahoo + Gemini.
USER node

# server.js listens on PORT. node-cron schedules are registered on require,
# so the process stays up serving HTTP + cron jobs from a single Node process.
CMD ["node", "backend/server.js"]