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

COPY package.json ./
COPY .actor ./.actor
COPY bin ./bin
COPY src ./src
COPY README.md ./

EXPOSE 8080

CMD ["node", "./src/main.mjs"]
