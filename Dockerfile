FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
