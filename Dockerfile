FROM node:16

WORKDIR /opt/electrakit
COPY package*.json ./

RUN npm install
COPY src ./src

VOLUME /opt/electrakit/persist
CMD ["node", "src/main.mjs"]

