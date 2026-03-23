FROM node:20-slim

# Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# node-canvas dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
