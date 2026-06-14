# Multi-stage Dockerfile for Twitter Sentiment Analysis App
# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend with Python support
FROM node:20-alpine
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# Install Python ML dependencies
COPY ml/requirements.txt ./ml/
# Use --break-system-packages for newer Alpine compatibility
RUN pip3 install --no-cache-dir -r ml/requirements.txt --break-system-packages

# Pre-download NLTK data to avoid runtime delays
RUN python3 -c "import nltk; nltk.download('vader_lexicon')"

# Install backend dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --production

# Copy application files
COPY backend/ ./backend/
COPY ml/ ./ml/
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 5000
ENV NODE_ENV=production
ENV PORT=5000

CMD ["node", "backend/server.js"]
