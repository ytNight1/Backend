FROM node:20-slim
WORKDIR /app

COPY package*.json ./

# sharp tem problemas em Alpine — instala sem ele primeiro, depois com flags nativas
RUN npm ci --only=production --ignore-scripts || npm install --only=production --ignore-scripts

COPY . .
RUN mkdir -p logs uploads

EXPOSE 3001

CMD ["node", "src/server.js"]
