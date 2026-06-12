# Dockerfile for the Agent Search webapp (Railway).
# Node + Playwright Chromium (Zillow engine) + Express (server).

FROM node:20-slim

WORKDIR /app

# procps provides `ps`, which crawlee's memory monitor shells out to.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

# Install production deps first (better layer caching).
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Install the Chromium build matching the installed Playwright + its OS deps.
RUN npx playwright install --with-deps chromium

# App source.
COPY . .

ENV NODE_ENV=production
# Railway provides PORT; the server already reads process.env.PORT.
EXPOSE 3000

CMD ["node", "web/server/index.js"]
