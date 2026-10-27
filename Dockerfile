# Small production image for the Node.js API and static browser client.
FROM node:20-alpine
WORKDIR /app
# Install only locked production dependencies before copying source for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev
# Copy only runtime assets; tests and local development files stay outside the image.
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts
# The container listens on APP_PORT, which defaults to 3000.
EXPOSE 3000
# Run without root privileges; runtime code does not need to write application files.
USER node
CMD ["node", "src/server.js"]
