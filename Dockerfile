# Dockerfile - simple, production-friendly
FROM node:22-alpine
WORKDIR /usr/src/app


# install dependencies
COPY package*.json ./
RUN npm ci --only=production


# copy source
COPY . .


# runtime env
ENV NODE_ENV=production


# Expose the port your app listens on
EXPOSE 10000


# Start command
CMD ["node", "index.upgraded.js"]
