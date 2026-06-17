FROM node:20-bookworm

WORKDIR /usr/lolisafe

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./

RUN apt-get update &&\
apt-get install -y python3 make g++ git ffmpeg && \
pnpm install --frozen-lockfile && \
pnpm store prune && \
apt-get clean && rm -rf /var/lib/apt/lists/*

ADD config.sample.js config.js
ADD views/_globals.sample.njk views/_globals.njk

COPY . .
RUN mkdir uploads && mkdir database

CMD ["sh", "-c", "pnpm migrate && npx tsx ./lolisafe.ts"]
