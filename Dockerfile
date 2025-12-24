FROM node:20-alpine As development

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

###################
# BUILD FOR PRODUCTION
###################

FROM node:20-alpine As build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

# Copy all tool directories
COPY --chown=node:node avr_tools/ ./avr_tools/
COPY --chown=node:node tools/ ./tools/
COPY --chown=node:node utils/ ./utils/

# Copy main application files
COPY --chown=node:node loadTools.js .
COPY --chown=node:node index.js .

# Create and set permissions for the logs directory
RUN mkdir -p logs && chown -R node:node logs

USER node

CMD [ "node", "index.js" ]