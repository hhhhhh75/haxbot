# Chrome + all its system libraries are already installed in this image,
# which is what Fly.io machines need (they cannot apt-get install anything).
FROM ghcr.io/puppeteer/puppeteer:21.11.0

# Build the app as root so npm can write node_modules, then run as pptruser.
USER root
WORKDIR /app

# The browser is baked into the image: never download it again.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY run.js haxbot-EN.js map.hbs ./

RUN chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 3000

CMD ["node", "run.js"]
