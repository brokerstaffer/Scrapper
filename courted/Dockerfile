# Lightweight: this scraper is pure HTTP (fetch) — no browser needed.
FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version

COPY . ./

CMD npm start --silent
