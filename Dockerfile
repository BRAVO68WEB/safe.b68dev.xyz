FROM node:20-bookworm

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Install system dependencies
RUN apt-get update && \
    apt-get install -y python3 make g++ git ffmpeg && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Create necessary directories
RUN mkdir -p uploads database

# Expose port
EXPOSE 9999

# Start command
CMD ["sh", "-c", "pnpm migrate && npx tsx ./lolisafe.ts"]
