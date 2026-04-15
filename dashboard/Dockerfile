FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY server.mjs ./
COPY public/ ./public/
ENV PORT=18062
EXPOSE 18062
CMD ["node", "server.mjs"]
