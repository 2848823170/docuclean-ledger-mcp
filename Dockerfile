FROM node:22-bookworm-slim

# Install Python 3 + PyMuPDF (fitz) for high-precision vector PDF table extraction;
# the Node server also includes a pure-JS FlateDecode/CMap fallback if Python is absent.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ca-certificates \
  && python3 -m venv /opt/pdfvenv \
  && /opt/pdfvenv/bin/pip install --no-cache-dir pymupdf==1.25.3 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/pdfvenv/bin:${PATH}" \
    NODE_ENV="production" \
    PORT="8080"

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY .actor ./.actor
COPY bin ./bin
COPY src ./src
COPY mcpize.yaml server.json README.md ./

RUN chown -R node:node /usr/src/app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
