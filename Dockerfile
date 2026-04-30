# ═══════════════════════════════════════════════════════════════
# BARLO — Dockerfile for Render deployment
# Node.js + Python + LibreOffice (for PPTX generation & PDF conversion)
# ═══════════════════════════════════════════════════════════════
FROM node:20-slim

# Install: node-canvas deps + Python 3 + pip + LibreOffice (headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    python3-pip \
    python3-dev \
    libreoffice-impress \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Symlink python → python3
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy server + Python scripts + PPTX template + Studio
COPY server.js .
COPY generate_pptx.py .
COPY generate_charts.py .
COPY template_diagnostic.pptx .
COPY studio.html .
COPY reference_axo.png .

EXPOSE 3000
CMD ["node", "server.js"]
