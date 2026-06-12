FROM apify/actor-node-playwright-chrome:18

# Copy package files and install production dependencies first (better caching).
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy the rest of the source.
COPY --chown=myuser . ./

CMD npm start --silent
