# =============================================================================
# Stage 1: Dependencies (production node_modules)
# =============================================================================
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# =============================================================================
# Stage 2: Builder — deps + source (usado por docker-compose.dev con tsx)
# =============================================================================
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# No ejecutar `npm run build` aquí: el perfil dev corre con tsx (`npm run dev`).

# =============================================================================
# Stage 3: Compile TypeScript for production image
# =============================================================================
FROM builder AS compiled
RUN npm run build

# =============================================================================
# Stage 4: Production
# =============================================================================
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S lumia -u 1001 -G nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY --from=compiled /app/dist ./dist
COPY package.json ./

RUN mkdir -p uploads logs backups && chown -R lumia:nodejs uploads logs backups

USER lumia

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health/live || exit 1

CMD ["node", "dist/server.js"]
